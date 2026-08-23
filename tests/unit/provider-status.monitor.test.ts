import { firstValueFrom } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import {
	ProviderStatusError,
	ProviderStatusMonitor,
	type ProviderStatusMonitorOptions,
	type ProviderStatusProvider,
	type ProviderStatusReport,
} from "../../src/core/index.ts";

const INITIAL_TIME = Date.parse("2026-08-23T12:00:00.000Z");

function passiveProvider(id = "openai", name = "OpenAI"): ProviderStatusProvider {
	return { id, name, statusPageUrl: `https://status.example.test/${id}` };
}

function checkingProvider(
	check: NonNullable<ProviderStatusProvider["check"]>,
	id = "openai",
	name = "OpenAI",
): ProviderStatusProvider {
	return { ...passiveProvider(id, name), check };
}

function createMonitor(
	providers: readonly ProviderStatusProvider[],
	options: Omit<ProviderStatusMonitorOptions, "providers"> = {},
): ProviderStatusMonitor {
	return new ProviderStatusMonitor({
		providers,
		polling: false,
		clock: () => INITIAL_TIME,
		...options,
	});
}

describe("ProviderStatusMonitor", () => {
	it("starts with an immutable unknown snapshot and replays it to observers", async () => {
		const monitor = createMonitor([passiveProvider()]);

		const snapshot = monitor.getSnapshot();
		const replayed = await firstValueFrom(monitor.status$);
		const watched = await firstValueFrom(monitor.watch("openai"));

		expect(replayed).toBe(snapshot);
		expect(watched).toBe(snapshot.providers[0]);
		expect(snapshot).toMatchObject({
			computedAt: "2026-08-23T12:00:00.000Z",
			status: "unknown",
			warnings: [],
			providers: [
				{
					id: "openai",
					status: "unknown",
					reportedStatus: null,
					observedStatus: "unknown",
					sourceState: "not-configured",
					stale: false,
				},
			],
		});
		expect(monitor.has("openai")).toBe(true);
		expect(monitor.get("missing")).toBeUndefined();
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.providers)).toBe(true);
		expect(Object.isFrozen(snapshot.providers[0]?.observations)).toBe(true);
	});

	it("does not re-emit a watched provider when only another provider changes", () => {
		const monitor = createMonitor([
			passiveProvider("openai", "OpenAI"),
			passiveProvider("anthropic", "Anthropic"),
		]);
		const emissions: unknown[] = [];
		const subscription = monitor.watch("openai").subscribe((health) => emissions.push(health));

		monitor.reportSuccess("anthropic");

		expect(emissions).toHaveLength(1);
		subscription.unsubscribe();
	});

	it("validates provider definitions and monitor thresholds", () => {
		expect(() =>
			createMonitor([passiveProvider("duplicate"), passiveProvider("duplicate")]),
		).toThrowError(
			expect.objectContaining({ code: "DUPLICATE_PROVIDER", providerId: "duplicate" }),
		);
		expect(() => createMonitor([passiveProvider("bad id")])).toThrowError(
			expect.objectContaining({ code: "INVALID_OPTIONS", providerId: "bad id" }),
		);
		expect(() => createMonitor([passiveProvider("valid", "   ")])).toThrowError(
			expect.objectContaining({ code: "INVALID_OPTIONS", providerId: "valid" }),
		);
		expect(
			() =>
				new ProviderStatusMonitor({
					providers: [],
					polling: { jitterRatio: 2 },
				}),
		).toThrow(/jitterRatio/);
		expect(() =>
			createMonitor([], {
				observations: { degradedErrorRate: 0.8, downErrorRate: 0.5 },
			}),
		).toThrow(/downErrorRate/);
		expect(() => createMonitor([], { observations: { degradedLatencyMs: Number.NaN } })).toThrow(
			/degradedLatencyMs/,
		);
	});

	it("registers and unregisters providers while rejecting duplicate and unknown ids", async () => {
		const monitor = createMonitor([]);
		const snapshots: number[] = [];
		const subscription = monitor.status$.subscribe((snapshot) => {
			snapshots.push(snapshot.providers.length);
		});

		monitor.register(passiveProvider("custom", "Custom"));
		expect(monitor.get("custom")?.name).toBe("Custom");
		expect(() => monitor.register(passiveProvider("custom", "Duplicate"))).toThrowError(
			expect.objectContaining({ code: "DUPLICATE_PROVIDER" }),
		);
		await expect(monitor.refresh("missing")).rejects.toMatchObject({ code: "UNKNOWN_PROVIDER" });
		expect(() => monitor.reportSuccess("missing")).toThrowError(
			expect.objectContaining({ code: "UNKNOWN_PROVIDER" }),
		);
		expect(monitor.unregister("custom")).toBe(true);
		expect(monitor.unregister("custom")).toBe(false);
		expect(snapshots).toEqual([0, 1, 0]);

		subscription.unsubscribe();
	});

	it("refreshes all checkable providers concurrently and normalizes reports", async () => {
		const component = { id: "api", name: "API", status: "degraded" as const };
		const incident = {
			id: "incident-1",
			name: "Elevated errors",
			status: "investigating",
			components: ["API"],
		};
		const report: ProviderStatusReport = {
			status: "degraded",
			description: "Requests may fail.",
			statusPageUrl: "https://status.vendor.test",
			upstreamUpdatedAt: "2026-08-23T11:59:00.000Z",
			components: [component],
			incidents: [incident],
		};
		const firstCheck = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(
			async ({ signal, checkedAt }) => {
				expect(signal.aborted).toBe(false);
				expect(checkedAt).toBe("2026-08-23T12:00:00.000Z");
				return report;
			},
		);
		const secondCheck = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(async () => ({
			status: "operational",
		}));
		const monitor = createMonitor([
			checkingProvider(firstCheck),
			checkingProvider(secondCheck, "anthropic", "Anthropic"),
		]);

		const snapshot = await monitor.refresh();
		const health = monitor.get("openai");
		(component as { name: string }).name = "mutated";

		expect(firstCheck).toHaveBeenCalledOnce();
		expect(secondCheck).toHaveBeenCalledOnce();
		expect(snapshot.status).toBe("degraded");
		expect(health).toMatchObject({
			status: "degraded",
			reportedStatus: "degraded",
			observedStatus: "unknown",
			description: "Requests may fail.",
			statusPageUrl: "https://status.vendor.test",
			upstreamUpdatedAt: "2026-08-23T11:59:00.000Z",
			sourceState: "available",
			checkedAt: "2026-08-23T12:00:00.000Z",
			stale: false,
		});
		expect(component.name).toBe("mutated");
		expect(health?.components).toEqual([{ id: "api", name: "API", status: "degraded" }]);
		expect(snapshot.warnings).toEqual([
			expect.objectContaining({
				id: "openai:degraded",
				kind: "degraded",
				severity: "warning",
				message: "Elevated errors",
				incident,
			}),
		]);
	});

	it("coalesces concurrent refreshes for the same provider", async () => {
		let resolveCheck: ((report: ProviderStatusReport) => void) | undefined;
		const deferred = new Promise<ProviderStatusReport>((resolve) => {
			resolveCheck = resolve;
		});
		const check = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(() => deferred);
		const monitor = createMonitor([checkingProvider(check)]);

		const first = monitor.refresh("openai");
		const second = monitor.refresh("openai");
		await Promise.resolve();

		expect(check).toHaveBeenCalledOnce();
		resolveCheck?.({ status: "operational" });
		await Promise.all([first, second]);
		expect(monitor.get("openai")?.sourceState).toBe("available");
	});

	it("retains the last successful report when a later source refresh fails", async () => {
		const check = vi
			.fn<NonNullable<ProviderStatusProvider["check"]>>()
			.mockResolvedValueOnce({ status: "operational", description: "Healthy" })
			.mockRejectedValueOnce(new Error("upstream unavailable"));
		const monitor = createMonitor([checkingProvider(check)]);

		await monitor.refresh("openai");
		await monitor.refresh("openai");

		expect(monitor.get("openai")).toMatchObject({
			status: "operational",
			reportedStatus: "operational",
			description: "Healthy",
			sourceState: "unavailable",
			lastCheckError: {
				code: "CHECK_FAILED",
				message: "Unable to refresh OpenAI status.",
			},
		});
		expect(monitor.getSnapshot().warnings).toContainEqual(
			expect.objectContaining({ id: "openai:source-unavailable" }),
		);
		expect(Object.isFrozen(monitor.get("openai")?.lastCheckError)).toBe(true);
		expect(Object.isFrozen(monitor.getSnapshot().warnings[0])).toBe(true);
	});

	it("classifies invalid reports and timed-out checks without rejecting refresh", async () => {
		vi.useFakeTimers();
		const invalidReport = new Proxy<ProviderStatusReport>(
			{ status: "operational" },
			{
				get(target, property, receiver) {
					if (property === "status") return "not-a-status";
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const invalidCheck = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(
			async () => invalidReport,
		);
		let timedOutSignal: AbortSignal | undefined;
		const timeoutCheck = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(({ signal }) => {
			timedOutSignal = signal;
			return new Promise<ProviderStatusReport>(() => undefined);
		});
		const monitor = new ProviderStatusMonitor({
			providers: [
				checkingProvider(invalidCheck, "invalid", "Invalid"),
				checkingProvider(timeoutCheck, "slow", "Slow"),
			],
			polling: { timeoutMs: 25, intervalMs: 1_000, startOnBootstrap: false },
			clock: () => INITIAL_TIME,
		});

		await monitor.refresh("invalid");
		const timeoutRefresh = monitor.refresh("slow");
		await vi.advanceTimersByTimeAsync(25);
		await timeoutRefresh;

		expect(monitor.get("invalid")?.lastCheckError?.code).toBe("INVALID_REPORT");
		expect(monitor.get("slow")?.lastCheckError?.code).toBe("CHECK_TIMEOUT");
		expect(timedOutSignal?.aborted).toBe(true);
	});

	it("propagates caller cancellation without producing a source warning", async () => {
		const check = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(
			({ signal }) =>
				new Promise<ProviderStatusReport>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const monitor = createMonitor([checkingProvider(check)]);
		const controller = new AbortController();
		const refresh = monitor.refresh("openai", { signal: controller.signal });
		controller.abort(new DOMException("Caller cancelled.", "AbortError"));

		await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
		expect(monitor.get("openai")?.sourceState).toBe("pending");
		expect(monitor.get("openai")?.lastCheckError).toBeUndefined();
		expect(monitor.getSnapshot().warnings).toEqual([]);
	});

	it("derives status and latency percentiles from runtime observations", () => {
		const monitor = createMonitor([passiveProvider()], {
			observations: {
				minimumSamples: 4,
				degradedErrorRate: 0.25,
				downErrorRate: 0.75,
				downAfterConsecutiveFailures: 3,
				degradedLatencyMs: 100,
			},
		});

		for (const latencyMs of [10, 20, 30, 200]) {
			monitor.reportSuccess("openai", { latencyMs, modelId: "gpt-test" });
		}

		const health = monitor.get("openai");
		expect(health?.status).toBe("degraded");
		expect(health?.observations).toMatchObject({
			status: "degraded",
			sampleCount: 4,
			successCount: 4,
			failureCount: 0,
			consecutiveSuccesses: 4,
			errorRate: 0,
			latencyMs: { last: 200, p50: 20, p95: 200 },
		});

		monitor.reportFailure("openai", { classification: "transient" });
		monitor.reportFailure("openai", { classification: "network" });
		monitor.reportFailure("openai", { classification: "timeout" });
		expect(monitor.get("openai")?.observations.consecutiveFailures).toBe(3);
		expect(monitor.get("openai")?.status).toBe("down");
	});

	it("keeps caller errors visible without degrading provider availability", () => {
		const monitor = createMonitor([passiveProvider()]);

		monitor.reportFailure("openai", {
			latencyMs: 12.345,
			statusCode: 401,
			modelId: "gpt-test",
			affectsStatus: false,
			classification: "auth",
		});

		const health = monitor.get("openai");
		expect(health?.status).toBe("unknown");
		expect(health?.observations).toMatchObject({
			sampleCount: 0,
			failureCount: 0,
			ignoredFailureCount: 1,
			lastFailure: {
				latencyMs: 12.35,
				statusCode: 401,
				modelId: "gpt-test",
				affectsStatus: false,
				classification: "auth",
			},
		});
		expect(monitor.getSnapshot().warnings).toContainEqual(
			expect.objectContaining({
				id: "openai:request-error",
				message: "OpenAI rejected a request because authentication failed.",
			}),
		);

		const cancelled = createMonitor([passiveProvider()]);
		cancelled.reportFailure("openai", {
			affectsStatus: false,
			classification: "cancelled",
		});
		expect(cancelled.getSnapshot().warnings).toEqual([]);
	});

	it("prunes observations by maximum sample count and sliding time window", () => {
		let now = INITIAL_TIME;
		const monitor = createMonitor([passiveProvider()], {
			clock: () => now,
			observations: { windowMs: 1_000, maxSamples: 2, minimumSamples: 1 },
		});

		monitor.reportSuccess("openai", { latencyMs: 1 });
		now += 100;
		monitor.reportSuccess("openai", { latencyMs: 2 });
		now += 100;
		monitor.reportSuccess("openai", { latencyMs: 3 });
		expect(monitor.get("openai")?.observations).toMatchObject({
			sampleCount: 2,
			latencyMs: { last: 3 },
		});

		now += 1_001;
		monitor.reportSuccess("openai", { latencyMs: 4 });
		expect(monitor.get("openai")?.observations).toMatchObject({
			sampleCount: 1,
			latencyMs: { last: 4, p50: 4, p95: 4 },
		});
	});

	it("automatically expires observations when their sliding window elapses", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(INITIAL_TIME);
		const monitor = new ProviderStatusMonitor({
			providers: [passiveProvider()],
			polling: false,
			observations: {
				windowMs: 1_000,
				minimumSamples: 1,
				downAfterConsecutiveFailures: 2,
			},
		});

		monitor.reportFailure("openai", { classification: "network" });
		expect(monitor.get("openai")?.observations.sampleCount).toBe(1);
		expect(monitor.get("openai")?.status).toBe("down");

		await vi.advanceTimersByTimeAsync(1_000);

		expect(monitor.get("openai")?.observations).toMatchObject({
			status: "unknown",
			sampleCount: 0,
			failureCount: 0,
			consecutiveFailures: 0,
		});
		expect(monitor.get("openai")?.status).toBe("unknown");
		expect(monitor.getSnapshot().warnings).toEqual([]);
	});

	it("applies availability policies and throws a typed unavailable error", () => {
		const unknown = createMonitor([passiveProvider()]);
		expect(unknown.isAvailable("openai")).toBe(true);
		expect(unknown.isAvailable("openai", { allowUnknown: false })).toBe(false);

		const degraded = createMonitor([passiveProvider()]);
		degraded.reportFailure("openai");
		expect(degraded.isAvailable("openai")).toBe(true);
		expect(degraded.isAvailable("openai", { allowDegraded: false })).toBe(false);

		const down = createMonitor([passiveProvider()], {
			observations: { downAfterConsecutiveFailures: 1 },
		});
		down.reportFailure("openai");
		expect(() => down.assertAvailable("openai")).toThrowError(
			expect.objectContaining({
				code: "PROVIDER_UNAVAILABLE",
				providerId: "openai",
				status: "down",
			}),
		);
		expect(() => down.assertAvailable("openai")).toThrowError(ProviderStatusError);
	});

	it("evaluates reported and observed signals independently for availability", async () => {
		const monitor = createMonitor([checkingProvider(async () => ({ status: "maintenance" }))]);
		await monitor.refresh("openai");
		monitor.reportFailure("openai", { classification: "network" });

		expect(monitor.get("openai")).toMatchObject({
			status: "maintenance",
			reportedStatus: "maintenance",
			observedStatus: "degraded",
		});
		expect(monitor.isAvailable("openai")).toBe(false);
		expect(
			monitor.isAvailable("openai", {
				allowMaintenance: true,
				allowDegraded: false,
			}),
		).toBe(false);
		expect(
			monitor.isAvailable("openai", {
				allowMaintenance: true,
				allowDegraded: true,
			}),
		).toBe(true);
	});

	it("marks retained reports stale and emits a stale warning", async () => {
		let now = INITIAL_TIME;
		const monitor = new ProviderStatusMonitor({
			providers: [checkingProvider(async () => ({ status: "operational" }))],
			polling: {
				intervalMs: 1_000,
				timeoutMs: 100,
				staleAfterMs: 1_500,
				startOnBootstrap: false,
			},
			clock: () => now,
		});
		await monitor.refresh("openai");

		now += 1_500;
		monitor.register(passiveProvider("trigger", "Trigger"));

		expect(monitor.get("openai")).toMatchObject({ sourceState: "stale", stale: true });
		expect(monitor.getSnapshot().warnings).toContainEqual(
			expect.objectContaining({ id: "openai:stale", kind: "stale" }),
		);
	});

	it("marks manually refreshed reports stale without another monitor event", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(INITIAL_TIME);
		const monitor = new ProviderStatusMonitor({
			providers: [checkingProvider(async () => ({ status: "operational" }))],
			polling: false,
		});
		await monitor.refresh("openai");

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(monitor.get("openai")).toMatchObject({
			status: "unknown",
			reportedStatus: "operational",
			sourceState: "stale",
			stale: true,
		});
		expect(monitor.getSnapshot().warnings).toContainEqual(
			expect.objectContaining({ id: "openai:stale" }),
		);
	});

	it("polls immediately, waits the configured interval, and stops cleanly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(INITIAL_TIME);
		const check = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(async () => ({
			status: "operational",
		}));
		const monitor = new ProviderStatusMonitor({
			providers: [checkingProvider(check)],
			polling: {
				intervalMs: 100,
				timeoutMs: 50,
				jitterRatio: 0,
				startOnBootstrap: false,
				unref: false,
			},
		});

		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(check).toHaveBeenCalledTimes(2);

		monitor.stop();
		await vi.advanceTimersByTimeAsync(500);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("does not create duplicate polling loops when stopped and restarted mid-check", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(INITIAL_TIME);
		let invocation = 0;
		const check = vi.fn<NonNullable<ProviderStatusProvider["check"]>>(({ signal }) => {
			invocation += 1;
			if (invocation > 1) return Promise.resolve({ status: "operational" });
			return new Promise<ProviderStatusReport>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const monitor = new ProviderStatusMonitor({
			providers: [checkingProvider(check)],
			polling: {
				intervalMs: 100,
				timeoutMs: 1_000,
				jitterRatio: 0,
				startOnBootstrap: false,
				unref: false,
			},
		});

		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledTimes(1);
		monitor.stop();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(100);
		expect(check).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(100);
		expect(check).toHaveBeenCalledTimes(3);
		monitor.stop();
	});

	it("suppresses duplicate warning emissions while status observations change", () => {
		const monitor = createMonitor([passiveProvider()]);
		const emissions: unknown[] = [];
		const subscription = monitor.warnings$.subscribe((warnings) => emissions.push(warnings));

		monitor.reportSuccess("openai", { latencyMs: 10 });
		monitor.reportSuccess("openai", { latencyMs: 20 });
		expect(emissions).toHaveLength(1);

		monitor.reportFailure("openai", {
			affectsStatus: false,
			classification: "rate-limit",
		});
		expect(emissions).toHaveLength(2);
		subscription.unsubscribe();
	});
});
