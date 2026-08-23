import { BehaviorSubject, distinctUntilChanged, map, type Observable } from "rxjs";
import { ProviderStatusError } from "./provider-status.error.ts";
import type {
	ProviderStatusAvailabilityOptions,
	ProviderStatusCheckError,
	ProviderStatusHealth,
	ProviderStatusMonitorOptions,
	ProviderStatusObservationDetails,
	ProviderStatusObservationEvidence,
	ProviderStatusObservationSummary,
	ProviderStatusProvider,
	ProviderStatusRefreshOptions,
	ProviderStatusReport,
	ProviderStatusSnapshot,
	ProviderStatusSourceState,
	ProviderStatusWarning,
} from "./provider-status.types.ts";
import {
	isProviderAvailable,
	isProviderStatus,
	percentile,
	worstProviderStatus,
} from "./provider-status.utils.ts";

interface ResolvedPollingOptions {
	readonly intervalMs: number;
	readonly timeoutMs: number;
	readonly staleAfterMs: number;
	readonly jitterRatio: number;
	readonly startOnBootstrap: boolean;
	readonly unref: boolean;
}

interface ResolvedObservationOptions {
	readonly windowMs: number;
	readonly maxSamples: number;
	readonly minimumSamples: number;
	readonly degradedErrorRate: number;
	readonly downErrorRate: number;
	readonly downAfterConsecutiveFailures: number;
	readonly degradedLatencyMs?: number;
}

interface ResolvedWarningOptions {
	readonly includeUnknown: boolean;
	readonly includeSourceUnavailable: boolean;
	readonly includeStale: boolean;
	readonly includeRequestErrors: boolean;
}

interface Observation {
	readonly outcome: "success" | "failure";
	readonly atMs: number;
	readonly at: string;
	readonly latencyMs?: number;
	readonly statusCode?: number;
	readonly modelId?: string;
	readonly affectsStatus: boolean;
	readonly classification?: ProviderStatusObservationDetails["classification"];
}

interface SuccessfulReport {
	readonly report: ProviderStatusReport;
	readonly checkedAtMs: number;
	readonly checkedAt: string;
}

interface ProviderRuntime {
	provider: ProviderStatusProvider;
	report?: SuccessfulReport;
	lastAttemptAt?: string;
	lastCheckError?: ProviderStatusCheckError;
	observations: Observation[];
}

const DEFAULT_POLLING_INTERVAL_MS = 60_000;
const DEFAULT_POLLING_TIMEOUT_MS = 5_000;
const DEFAULT_OBSERVATION_WINDOW_MS = 5 * 60_000;

/**
 * Framework-neutral provider status engine. NestJS applications normally
 * inject `ProviderStatusService`, which adds application lifecycle hooks.
 */
export class ProviderStatusMonitor {
	readonly status$: Observable<ProviderStatusSnapshot>;
	readonly warnings$: Observable<readonly ProviderStatusWarning[]>;
	readonly polling: false | ResolvedPollingOptions;

	private readonly clock: () => number;
	private readonly random: () => number;
	private readonly observations: ResolvedObservationOptions;
	private readonly warningOptions: ResolvedWarningOptions;
	private readonly runtimes = new Map<string, ProviderRuntime>();
	private readonly refreshes = new Map<string, Promise<void>>();
	private readonly activeControllers = new Set<AbortController>();
	private readonly subject: BehaviorSubject<ProviderStatusSnapshot>;
	private pollingTimer?: ReturnType<typeof setTimeout>;
	private observationTimer?: ReturnType<typeof setTimeout>;
	private staleTimer?: ReturnType<typeof setTimeout>;
	private pollingGeneration = 0;
	private running = false;

	constructor(options: ProviderStatusMonitorOptions) {
		if (!options || typeof options !== "object" || !Array.isArray(options.providers)) {
			throw new ProviderStatusError(
				"INVALID_OPTIONS",
				"Provider status options must include a providers array.",
			);
		}
		this.clock = options.clock ?? Date.now;
		this.random = options.random ?? Math.random;
		this.polling = resolvePollingOptions(options.polling);
		this.observations = resolveObservationOptions(options.observations);
		this.warningOptions = resolveWarningOptions(options.warnings);

		for (const provider of options.providers) this.registerInitial(provider);

		this.subject = new BehaviorSubject(this.createSnapshot());
		this.status$ = this.subject.asObservable();
		this.warnings$ = this.status$.pipe(
			map((snapshot) => snapshot.warnings),
			distinctUntilChanged(warningsEqual),
		);
	}

	getSnapshot(): ProviderStatusSnapshot {
		return this.subject.value;
	}

	get(providerId: string): ProviderStatusHealth | undefined {
		return this.subject.value.providers.find((provider) => provider.id === providerId);
	}

	has(providerId: string): boolean {
		return this.runtimes.has(providerId);
	}

	watch(providerId: string): Observable<ProviderStatusHealth | undefined> {
		return this.status$.pipe(
			map((snapshot) => snapshot.providers.find((provider) => provider.id === providerId)),
			distinctUntilChanged(healthEqual),
		);
	}

	register(provider: ProviderStatusProvider): void {
		this.assertProvider(provider);
		if (this.runtimes.has(provider.id)) {
			throw new ProviderStatusError(
				"DUPLICATE_PROVIDER",
				`Provider status id "${provider.id}" is already registered.`,
				{ providerId: provider.id },
			);
		}
		this.runtimes.set(provider.id, { provider, observations: [] });
		this.emitSnapshot();
		this.scheduleStaleTransition();
		if (this.running && provider.check) void this.refresh(provider.id);
	}

	unregister(providerId: string): boolean {
		const removed = this.runtimes.delete(providerId);
		if (removed) {
			this.emitSnapshot();
			this.scheduleObservationExpiry();
			this.scheduleStaleTransition();
		}
		return removed;
	}

	async refresh(
		providerId?: string,
		options: ProviderStatusRefreshOptions = {},
	): Promise<ProviderStatusSnapshot> {
		if (providerId !== undefined) {
			const runtime = this.requireRuntime(providerId);
			await this.refreshRuntime(runtime, options);
		} else {
			await Promise.all(
				[...this.runtimes.values()].map((runtime) => this.refreshRuntime(runtime, options)),
			);
		}
		const snapshot = this.emitSnapshot();
		this.scheduleStaleTransition();
		return snapshot;
	}

	reportSuccess(providerId: string, details: ProviderStatusObservationDetails = {}): void {
		this.recordObservation(providerId, "success", details);
	}

	reportFailure(providerId: string, details: ProviderStatusObservationDetails = {}): void {
		this.recordObservation(providerId, "failure", details);
	}

	isAvailable(providerId: string, options: ProviderStatusAvailabilityOptions = {}): boolean {
		return isProviderAvailable(this.requireHealth(providerId), options);
	}

	assertAvailable(
		providerId: string,
		options: ProviderStatusAvailabilityOptions = {},
	): ProviderStatusHealth {
		const health = this.requireHealth(providerId);
		if (isProviderAvailable(health, options)) return health;
		throw new ProviderStatusError(
			"PROVIDER_UNAVAILABLE",
			`Provider "${providerId}" is ${health.status}.`,
			{ providerId, status: health.status },
		);
	}

	start(): void {
		this.scheduleObservationExpiry();
		this.scheduleStaleTransition();
		if (this.running || this.polling === false) return;
		this.running = true;
		const generation = ++this.pollingGeneration;
		void this.runPollingRound(generation);
	}

	stop(): void {
		this.running = false;
		this.pollingGeneration += 1;
		if (this.pollingTimer !== undefined) clearTimeout(this.pollingTimer);
		this.pollingTimer = undefined;
		if (this.observationTimer !== undefined) clearTimeout(this.observationTimer);
		this.observationTimer = undefined;
		if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
		this.staleTimer = undefined;
		for (const controller of this.activeControllers) {
			controller.abort(new DOMException("Provider status monitor stopped.", "AbortError"));
		}
		this.activeControllers.clear();
	}

	private registerInitial(provider: ProviderStatusProvider): void {
		this.assertProvider(provider);
		if (this.runtimes.has(provider.id)) {
			throw new ProviderStatusError(
				"DUPLICATE_PROVIDER",
				`Provider status id "${provider.id}" is configured more than once.`,
				{ providerId: provider.id },
			);
		}
		this.runtimes.set(provider.id, { provider, observations: [] });
	}

	private assertProvider(provider: ProviderStatusProvider): void {
		if (!provider || typeof provider !== "object") {
			throw new ProviderStatusError("INVALID_OPTIONS", "Every provider must be an object.");
		}
		if (typeof provider.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider.id)) {
			throw new ProviderStatusError(
				"INVALID_OPTIONS",
				"Provider ids must start with an alphanumeric character and contain only letters, numbers, dots, underscores, or hyphens.",
				{ providerId: provider.id },
			);
		}
		if (typeof provider.name !== "string" || provider.name.trim().length === 0) {
			throw new ProviderStatusError(
				"INVALID_OPTIONS",
				`Provider "${provider.id}" must have a display name.`,
				{ providerId: provider.id },
			);
		}
	}

	private requireRuntime(providerId: string): ProviderRuntime {
		const runtime = this.runtimes.get(providerId);
		if (runtime) return runtime;
		throw new ProviderStatusError(
			"UNKNOWN_PROVIDER",
			`Provider status id "${providerId}" is not registered.`,
			{ providerId },
		);
	}

	private requireHealth(providerId: string): ProviderStatusHealth {
		const health = this.get(providerId);
		if (health) return health;
		throw new ProviderStatusError(
			"UNKNOWN_PROVIDER",
			`Provider status id "${providerId}" is not registered.`,
			{ providerId },
		);
	}

	private refreshRuntime(
		runtime: ProviderRuntime,
		options: ProviderStatusRefreshOptions,
	): Promise<void> {
		if (!runtime.provider.check) return Promise.resolve();
		const existing = this.refreshes.get(runtime.provider.id);
		if (existing) return existing;

		const refresh = this.executeCheck(runtime, options).finally(() => {
			this.refreshes.delete(runtime.provider.id);
		});
		this.refreshes.set(runtime.provider.id, refresh);
		return refresh;
	}

	private async executeCheck(
		runtime: ProviderRuntime,
		options: ProviderStatusRefreshOptions,
	): Promise<void> {
		const checkedAtMs = this.clock();
		const checkedAt = new Date(checkedAtMs).toISOString();
		runtime.lastAttemptAt = checkedAt;

		const controller = new AbortController();
		this.activeControllers.add(controller);
		const timeoutMs = this.polling === false ? DEFAULT_POLLING_TIMEOUT_MS : this.polling.timeoutMs;
		const timeout = setTimeout(() => {
			controller.abort(new DOMException("Provider status check timed out.", "TimeoutError"));
		}, timeoutMs);
		unrefTimer(timeout);
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;

		try {
			const report = await raceWithSignal(
				Promise.resolve().then(() => runtime.provider.check!({ signal, checkedAt })),
				signal,
			);
			runtime.report = {
				report: normalizeReport(report, runtime.provider),
				checkedAtMs,
				checkedAt,
			};
			runtime.lastCheckError = undefined;
		} catch (cause) {
			const timedOut = controller.signal.aborted && isTimeoutReason(controller.signal.reason);
			if (!timedOut && options.signal?.aborted) throw cause;
			if (!timedOut && controller.signal.aborted && isAbortReason(controller.signal.reason)) return;
			const invalidReport = cause instanceof ProviderStatusError && cause.code === "INVALID_REPORT";
			runtime.lastCheckError = {
				code: timedOut ? "CHECK_TIMEOUT" : invalidReport ? "INVALID_REPORT" : "CHECK_FAILED",
				message: timedOut
					? `Timed out while checking ${runtime.provider.name}.`
					: invalidReport
						? `The ${runtime.provider.name} status source returned an invalid report.`
						: `Unable to refresh ${runtime.provider.name} status.`,
				at: new Date(this.clock()).toISOString(),
			};
		} finally {
			clearTimeout(timeout);
			this.activeControllers.delete(controller);
		}
	}

	private recordObservation(
		providerId: string,
		outcome: Observation["outcome"],
		details: ProviderStatusObservationDetails,
	): void {
		const runtime = this.requireRuntime(providerId);
		const now = this.clock();
		const atMs = normalizeObservationTime(details.at, now);
		const affectsStatus = outcome === "success" || details.affectsStatus !== false;
		const latencyMs = normalizeLatency(details.latencyMs);
		runtime.observations.push({
			outcome,
			atMs,
			at: new Date(atMs).toISOString(),
			...(latencyMs === undefined ? {} : { latencyMs }),
			...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
			...(details.modelId === undefined ? {} : { modelId: details.modelId }),
			affectsStatus,
			...(details.classification === undefined ? {} : { classification: details.classification }),
		});
		runtime.observations = runtime.observations.toSorted((left, right) => left.atMs - right.atMs);
		this.pruneObservations(runtime, now);
		if (runtime.observations.length > this.observations.maxSamples) {
			runtime.observations.splice(0, runtime.observations.length - this.observations.maxSamples);
		}
		this.emitSnapshot();
		this.scheduleObservationExpiry();
	}

	private pruneObservations(runtime: ProviderRuntime, now: number): void {
		const oldest = now - this.observations.windowMs;
		const firstRetained = runtime.observations.findIndex((sample) => sample.atMs > oldest);
		if (firstRetained === -1) runtime.observations.length = 0;
		else if (firstRetained > 0) runtime.observations.splice(0, firstRetained);
	}

	private summarizeObservations(
		runtime: ProviderRuntime,
		now: number,
	): ProviderStatusObservationSummary {
		this.pruneObservations(runtime, now);
		const relevant = runtime.observations.filter((sample) => sample.affectsStatus);
		const successful = relevant.filter((sample) => sample.outcome === "success");
		const failed = relevant.filter((sample) => sample.outcome === "failure");
		const ignoredFailures = runtime.observations.filter(
			(sample) => sample.outcome === "failure" && !sample.affectsStatus,
		);
		const latencies = relevant.flatMap((sample) =>
			sample.latencyMs === undefined ? [] : [sample.latencyMs],
		);
		const consecutiveFailures = countConsecutive(relevant, "failure");
		const consecutiveSuccesses = countConsecutive(relevant, "success");
		const errorRate = relevant.length === 0 ? null : failed.length / relevant.length;
		const p95 = percentile(latencies, 0.95);
		const lastFailure = runtime.observations.findLast((sample) => sample.outcome === "failure");
		const lastSuccessAt = runtime.observations.findLast(
			(sample) => sample.outcome === "success",
		)?.at;
		const lastFailureAt = lastFailure?.at;

		let status: ProviderStatusObservationSummary["status"] = "unknown";
		if (relevant.length > 0) {
			if (
				consecutiveFailures >= this.observations.downAfterConsecutiveFailures ||
				(relevant.length >= this.observations.minimumSamples &&
					errorRate !== null &&
					errorRate >= this.observations.downErrorRate)
			) {
				status = "down";
			} else if (
				(relevant.length < this.observations.minimumSamples && consecutiveFailures > 0) ||
				(relevant.length >= this.observations.minimumSamples &&
					errorRate !== null &&
					errorRate >= this.observations.degradedErrorRate) ||
				(this.observations.degradedLatencyMs !== undefined &&
					p95 !== null &&
					p95 >= this.observations.degradedLatencyMs)
			) {
				status = "degraded";
			} else {
				status = "operational";
			}
		}

		return {
			status,
			sampleCount: relevant.length,
			successCount: successful.length,
			failureCount: failed.length,
			ignoredFailureCount: ignoredFailures.length,
			consecutiveFailures,
			consecutiveSuccesses,
			errorRate,
			latencyMs: {
				last: latencies.at(-1) ?? null,
				p50: percentile(latencies, 0.5),
				p95,
			},
			...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
			...(lastFailureAt === undefined ? {} : { lastFailureAt }),
			...(lastFailure === undefined ? {} : { lastFailure: observationEvidence(lastFailure) }),
		};
	}

	private createSnapshot(): ProviderStatusSnapshot {
		const now = this.clock();
		const computedAt = new Date(now).toISOString();
		const providers = [...this.runtimes.values()].map((runtime) => this.createHealth(runtime, now));
		const warnings = providers.flatMap((health) => createWarnings(health, this.warningOptions));
		return freezeSnapshot({
			computedAt,
			status: worstProviderStatus(providers.map((provider) => provider.status)),
			providers,
			warnings,
		});
	}

	private createHealth(runtime: ProviderRuntime, now: number): ProviderStatusHealth {
		const sourceState = resolveSourceState(runtime, now, this.staleAfterMs());
		const observations = this.summarizeObservations(runtime, now);
		const report = runtime.report?.report;
		const reportedStatus = report?.status ?? null;
		const usableReportedStatus = sourceState === "stale" ? "unknown" : reportedStatus;
		const status = worstProviderStatus([usableReportedStatus ?? "unknown", observations.status]);
		const stale = sourceState === "stale";

		return {
			id: runtime.provider.id,
			name: runtime.provider.name,
			status,
			reportedStatus,
			observedStatus: observations.status,
			...(report?.description === undefined ? {} : { description: report.description }),
			...((report?.statusPageUrl ?? runtime.provider.statusPageUrl)
				? { statusPageUrl: report?.statusPageUrl ?? runtime.provider.statusPageUrl }
				: {}),
			sourceState,
			...(runtime.report ? { checkedAt: runtime.report.checkedAt } : {}),
			...(report?.upstreamUpdatedAt === undefined
				? {}
				: { upstreamUpdatedAt: report.upstreamUpdatedAt }),
			stale,
			...(runtime.lastCheckError === undefined ? {} : { lastCheckError: runtime.lastCheckError }),
			components: report?.components ?? [],
			incidents: report?.incidents ?? [],
			observations,
		};
	}

	private staleAfterMs(): number {
		return this.polling === false
			? Math.max(3 * DEFAULT_POLLING_INTERVAL_MS, 5 * 60_000)
			: this.polling.staleAfterMs;
	}

	private emitSnapshot(): ProviderStatusSnapshot {
		const snapshot = this.createSnapshot();
		this.subject.next(snapshot);
		return snapshot;
	}

	private async runPollingRound(generation: number): Promise<void> {
		try {
			await this.refresh();
		} finally {
			if (this.running && this.polling !== false && generation === this.pollingGeneration) {
				const variance = this.polling.intervalMs * this.polling.jitterRatio;
				const delay = Math.max(
					0,
					Math.round(this.polling.intervalMs - variance + this.random() * variance * 2),
				);
				this.pollingTimer = setTimeout(() => void this.runPollingRound(generation), delay);
				if (this.polling.unref) unrefTimer(this.pollingTimer);
			}
		}
	}

	private scheduleObservationExpiry(): void {
		if (this.observationTimer !== undefined) clearTimeout(this.observationTimer);
		this.observationTimer = undefined;
		const nextExpiry = [...this.runtimes.values()]
			.flatMap((runtime) => runtime.observations[0]?.atMs ?? [])
			.map((atMs) => atMs + this.observations.windowMs)
			.reduce<number | undefined>(
				(earliest, expiry) => (earliest === undefined || expiry < earliest ? expiry : earliest),
				undefined,
			);
		if (nextExpiry === undefined) return;
		const delay = Math.max(0, nextExpiry - this.clock());
		this.observationTimer = setTimeout(() => {
			this.observationTimer = undefined;
			this.emitSnapshot();
			this.scheduleObservationExpiry();
		}, delay);
		if (this.polling === false || this.polling.unref) unrefTimer(this.observationTimer);
	}

	private scheduleStaleTransition(): void {
		if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
		this.staleTimer = undefined;
		const now = this.clock();
		const nextExpiry = [...this.runtimes.values()]
			.flatMap((runtime) =>
				runtime.report === undefined ? [] : [runtime.report.checkedAtMs + this.staleAfterMs()],
			)
			.filter((expiry) => expiry > now)
			.reduce<number | undefined>(
				(earliest, expiry) => (earliest === undefined || expiry < earliest ? expiry : earliest),
				undefined,
			);
		if (nextExpiry === undefined) return;
		this.staleTimer = setTimeout(() => {
			this.staleTimer = undefined;
			this.emitSnapshot();
			this.scheduleStaleTransition();
		}, nextExpiry - now);
		if (this.polling === false || this.polling.unref) unrefTimer(this.staleTimer);
	}
}

function resolvePollingOptions(
	options: ProviderStatusMonitorOptions["polling"],
): false | ResolvedPollingOptions {
	if (options === false) return false;
	const intervalMs = positiveNumber(options?.intervalMs, DEFAULT_POLLING_INTERVAL_MS, "intervalMs");
	const timeoutMs = positiveNumber(options?.timeoutMs, DEFAULT_POLLING_TIMEOUT_MS, "timeoutMs");
	const staleAfterMs = positiveNumber(
		options?.staleAfterMs,
		Math.max(3 * intervalMs, 5 * 60_000),
		"staleAfterMs",
	);
	const jitterRatio = options?.jitterRatio ?? 0.1;
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			"polling.jitterRatio must be between 0 and 1.",
		);
	}
	return {
		intervalMs,
		timeoutMs,
		staleAfterMs,
		jitterRatio,
		startOnBootstrap: options?.startOnBootstrap ?? true,
		unref: options?.unref ?? true,
	};
}

function resolveObservationOptions(
	options: ProviderStatusMonitorOptions["observations"],
): ResolvedObservationOptions {
	const windowMs = positiveNumber(options?.windowMs, DEFAULT_OBSERVATION_WINDOW_MS, "windowMs");
	const maxSamples = positiveInteger(options?.maxSamples, 200, "maxSamples");
	const minimumSamples = positiveInteger(options?.minimumSamples, 10, "minimumSamples");
	const downAfterConsecutiveFailures = positiveInteger(
		options?.downAfterConsecutiveFailures,
		6,
		"downAfterConsecutiveFailures",
	);
	const degradedErrorRate = rate(options?.degradedErrorRate, 0.2, "degradedErrorRate");
	const downErrorRate = rate(options?.downErrorRate, 0.5, "downErrorRate");
	if (downErrorRate < degradedErrorRate) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			"observations.downErrorRate must be greater than or equal to degradedErrorRate.",
		);
	}
	const degradedLatencyMs = options?.degradedLatencyMs;
	if (
		degradedLatencyMs !== undefined &&
		(!Number.isFinite(degradedLatencyMs) || degradedLatencyMs <= 0)
	) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			"observations.degradedLatencyMs must be a positive finite number.",
		);
	}
	return {
		windowMs,
		maxSamples,
		minimumSamples,
		degradedErrorRate,
		downErrorRate,
		downAfterConsecutiveFailures,
		...(degradedLatencyMs === undefined ? {} : { degradedLatencyMs }),
	};
}

function resolveWarningOptions(
	options: ProviderStatusMonitorOptions["warnings"],
): ResolvedWarningOptions {
	return {
		includeUnknown: options?.includeUnknown ?? true,
		includeSourceUnavailable: options?.includeSourceUnavailable ?? true,
		includeStale: options?.includeStale ?? true,
		includeRequestErrors: options?.includeRequestErrors ?? true,
	};
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved <= 0) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			`polling/observations.${name} must be a positive finite number.`,
		);
	}
	return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = positiveNumber(value, fallback, name);
	if (!Number.isInteger(resolved)) {
		throw new ProviderStatusError("INVALID_OPTIONS", `observations.${name} must be an integer.`);
	}
	return resolved;
}

function rate(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			`observations.${name} must be between 0 and 1.`,
		);
	}
	return resolved;
}

function normalizeReport(
	report: ProviderStatusReport,
	provider: ProviderStatusProvider,
): ProviderStatusReport {
	if (!report || typeof report !== "object" || !isProviderStatus(report.status)) {
		throw new ProviderStatusError(
			"INVALID_REPORT",
			`Provider "${provider.id}" returned an invalid status report.`,
			{ providerId: provider.id },
		);
	}
	if (report.components !== undefined && !Array.isArray(report.components)) {
		throw invalidProviderReport(provider.id);
	}
	if (report.incidents !== undefined && !Array.isArray(report.incidents)) {
		throw invalidProviderReport(provider.id);
	}
	return {
		status: report.status,
		...(report.description === undefined ? {} : { description: report.description }),
		...(report.statusPageUrl === undefined ? {} : { statusPageUrl: report.statusPageUrl }),
		...(report.upstreamUpdatedAt === undefined
			? {}
			: { upstreamUpdatedAt: report.upstreamUpdatedAt }),
		components: (report.components ?? []).map((component) => {
			if (
				!component ||
				typeof component !== "object" ||
				typeof component.id !== "string" ||
				typeof component.name !== "string" ||
				!isProviderStatus(component.status)
			) {
				throw invalidProviderReport(provider.id);
			}
			return { ...component };
		}),
		incidents: (report.incidents ?? []).map((incident) => {
			if (
				!incident ||
				typeof incident !== "object" ||
				typeof incident.id !== "string" ||
				typeof incident.name !== "string" ||
				typeof incident.status !== "string" ||
				!Array.isArray(incident.components)
			) {
				throw invalidProviderReport(provider.id);
			}
			return { ...incident, components: [...incident.components] };
		}),
	};
}

function invalidProviderReport(providerId: string): ProviderStatusError {
	return new ProviderStatusError(
		"INVALID_REPORT",
		`Provider "${providerId}" returned an invalid status report.`,
		{ providerId },
	);
}

function resolveSourceState(
	runtime: ProviderRuntime,
	now: number,
	staleAfterMs: number,
): ProviderStatusSourceState {
	if (!runtime.provider.check) return "not-configured";
	if (!runtime.report && !runtime.lastCheckError) return "pending";
	if (runtime.report && now - runtime.report.checkedAtMs >= staleAfterMs) return "stale";
	if (runtime.lastCheckError) return "unavailable";
	return runtime.report ? "available" : "unavailable";
}

function createWarnings(
	health: ProviderStatusHealth,
	options: ResolvedWarningOptions,
): ProviderStatusWarning[] {
	const warnings: ProviderStatusWarning[] = [];
	const reportedProblem =
		!health.stale &&
		health.reportedStatus !== null &&
		health.reportedStatus !== "operational" &&
		health.reportedStatus !== "unknown";
	const incident = reportedProblem ? health.incidents[0] : undefined;
	if (health.status === "down" || health.status === "degraded" || health.status === "maintenance") {
		const kind = health.status;
		warnings.push({
			id: `${health.id}:${kind}`,
			providerId: health.id,
			providerName: health.name,
			kind,
			severity: health.status === "down" ? "critical" : "warning",
			message:
				incident?.name ??
				(reportedProblem ? health.description : undefined) ??
				`${health.name} is ${health.status}.`,
			...(health.statusPageUrl === undefined ? {} : { statusPageUrl: health.statusPageUrl }),
			...(incident === undefined ? {} : { incident }),
		});
	}

	if (health.sourceState === "stale" && options.includeStale) {
		warnings.push({
			id: `${health.id}:stale`,
			providerId: health.id,
			providerName: health.name,
			kind: "stale",
			severity: "warning",
			message: `${health.name} status data is stale.`,
			...(health.statusPageUrl === undefined ? {} : { statusPageUrl: health.statusPageUrl }),
		});
	} else if (health.sourceState === "unavailable" && options.includeSourceUnavailable) {
		warnings.push({
			id: `${health.id}:source-unavailable`,
			providerId: health.id,
			providerName: health.name,
			kind: "source-unavailable",
			severity: "warning",
			message: health.lastCheckError?.message ?? `${health.name} status source is unavailable.`,
			...(health.statusPageUrl === undefined ? {} : { statusPageUrl: health.statusPageUrl }),
		});
	} else if (
		health.status === "unknown" &&
		options.includeUnknown &&
		health.sourceState !== "pending" &&
		health.sourceState !== "not-configured"
	) {
		warnings.push({
			id: `${health.id}:unknown`,
			providerId: health.id,
			providerName: health.name,
			kind: "unknown",
			severity: "warning",
			message: `${health.name} availability is unknown.`,
			...(health.statusPageUrl === undefined ? {} : { statusPageUrl: health.statusPageUrl }),
		});
	}

	const lastFailure = health.observations.lastFailure;
	if (
		options.includeRequestErrors &&
		lastFailure !== undefined &&
		!lastFailure.affectsStatus &&
		lastFailure.classification !== "cancelled"
	) {
		warnings.push({
			id: `${health.id}:request-error`,
			providerId: health.id,
			providerName: health.name,
			kind: "request-error",
			severity: "warning",
			message: requestErrorWarning(health.name, lastFailure.classification),
			...(health.statusPageUrl === undefined ? {} : { statusPageUrl: health.statusPageUrl }),
		});
	}

	return warnings;
}

function requestErrorWarning(
	providerName: string,
	classification: ProviderStatusObservationDetails["classification"],
): string {
	switch (classification) {
		case "rate-limit":
			return `${providerName} rejected a request because of a rate or quota limit.`;
		case "auth":
			return `${providerName} rejected a request because authentication failed.`;
		case "billing":
			return `${providerName} rejected a request because of a billing issue.`;
		case "configuration":
		case "permanent":
			return `${providerName} rejected a request because of its configuration or input.`;
		default:
			return `${providerName} rejected a request without indicating a provider outage.`;
	}
}

function normalizeObservationTime(value: string | Date | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(time) ? Math.min(time, fallback) : fallback;
}

function normalizeLatency(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value * 100) / 100;
}

function observationEvidence(observation: Observation): ProviderStatusObservationEvidence {
	return {
		at: observation.at,
		...(observation.latencyMs === undefined ? {} : { latencyMs: observation.latencyMs }),
		...(observation.statusCode === undefined ? {} : { statusCode: observation.statusCode }),
		...(observation.modelId === undefined ? {} : { modelId: observation.modelId }),
		affectsStatus: observation.affectsStatus,
		...(observation.classification === undefined
			? {}
			: { classification: observation.classification }),
	};
}

function countConsecutive(
	observations: readonly Observation[],
	outcome: Observation["outcome"],
): number {
	let count = 0;
	for (let index = observations.length - 1; index >= 0; index -= 1) {
		if (observations[index]?.outcome !== outcome) break;
		count += 1;
	}
	return count;
}

function isTimeoutReason(reason: unknown): boolean {
	return reason instanceof DOMException && reason.name === "TimeoutError";
}

function isAbortReason(reason: unknown): boolean {
	return reason instanceof DOMException && reason.name === "AbortError";
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason;
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
	candidate.unref?.();
}

function warningsEqual(
	left: readonly ProviderStatusWarning[],
	right: readonly ProviderStatusWarning[],
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function healthEqual(
	left: ProviderStatusHealth | undefined,
	right: ProviderStatusHealth | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function freezeSnapshot(snapshot: ProviderStatusSnapshot): ProviderStatusSnapshot {
	for (const provider of snapshot.providers) {
		for (const component of provider.components) Object.freeze(component);
		for (const incident of provider.incidents) {
			Object.freeze(incident.components);
			Object.freeze(incident);
		}
		if (provider.observations.lastFailure) Object.freeze(provider.observations.lastFailure);
		if (provider.lastCheckError) Object.freeze(provider.lastCheckError);
		Object.freeze(provider.components);
		Object.freeze(provider.incidents);
		Object.freeze(provider.observations.latencyMs);
		Object.freeze(provider.observations);
		Object.freeze(provider);
	}
	for (const warning of snapshot.warnings) Object.freeze(warning);
	Object.freeze(snapshot.providers);
	Object.freeze(snapshot.warnings);
	return Object.freeze(snapshot);
}
