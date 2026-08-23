import {
	ProviderStatusError,
	type ProviderStatus,
	type ProviderStatusIncident,
	type ProviderStatusProvider,
	type ProviderStatusReport,
	worstProviderStatus,
} from "../core/index.ts";
import type {
	NormalizedStatuspageSelection,
	StatuspageComponent,
	StatuspageComponentMatcher,
	StatuspageIncident,
	StatuspageProviderOptions,
	StatuspageReportOptions,
	StatuspageSummaryDocument,
} from "./statuspage.types.ts";

const STATUSPAGE_COMPONENT_STATUS: Readonly<Record<string, ProviderStatus>> = {
	operational: "operational",
	degraded_performance: "degraded",
	partial_outage: "degraded",
	major_outage: "down",
	under_maintenance: "maintenance",
};

const STATUSPAGE_INDICATOR_STATUS: Readonly<Record<string, ProviderStatus>> = {
	none: "operational",
	minor: "degraded",
	major: "down",
	critical: "down",
	maintenance: "maintenance",
};

export function createStatuspageProvider(
	options: StatuspageProviderOptions,
): ProviderStatusProvider {
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
	if (typeof fetchImplementation !== "function") {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			`No fetch implementation is available for provider "${options.id}".`,
			{ providerId: options.id },
		);
	}
	if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
		throw new ProviderStatusError(
			"INVALID_OPTIONS",
			`maxResponseBytes must be a positive integer for provider "${options.id}".`,
			{ providerId: options.id },
		);
	}

	return {
		id: options.id,
		name: options.name,
		statusPageUrl: options.statusPageUrl,
		check: async ({ signal }) => {
			const document =
				options.summaryUrl !== undefined
					? await fetchStatuspageDocument(
							fetchImplementation,
							options.summaryUrl,
							signal,
							options.headers,
							maxResponseBytes,
						)
					: await fetchSplitStatuspageDocument(
							fetchImplementation,
							options,
							signal,
							maxResponseBytes,
						);
			return statuspageDocumentToReport(document, {
				provider: options,
				...(options.components === undefined ? {} : { components: options.components }),
				requireComponents: options.requireComponents ?? true,
				maxIncidents: options.maxIncidents ?? 3,
				includeUnscopedIncidents: options.includeUnscopedIncidents ?? false,
			});
		},
	};
}

export function statuspageDocumentToReport(
	document: StatuspageSummaryDocument,
	options: StatuspageReportOptions,
): ProviderStatusReport {
	if (!document || typeof document !== "object") {
		throw invalidDocument(options.provider.id);
	}

	const selection = selectComponents(document.components ?? [], options.components);
	if (
		options.components !== undefined &&
		(options.requireComponents ?? true) &&
		selection.components.length === 0
	) {
		throw new ProviderStatusError(
			"INVALID_REPORT",
			`No configured components were found for provider "${options.provider.id}".`,
			{ providerId: options.provider.id },
		);
	}

	const status = selectionStatus(selection, document.status?.indicator);
	const incidents = normalizeIncidents(
		document.incidents ?? [],
		selection,
		options.components !== undefined,
		options.maxIncidents ?? 3,
		options.includeUnscopedIncidents ?? false,
	);
	const firstIncident = incidents[0];
	const description =
		status === "operational"
			? (document.status?.description ?? `${options.provider.name} is operational.`)
			: (firstIncident?.name ??
				document.status?.description ??
				`${options.provider.name} is ${status}.`);

	return {
		status,
		description,
		...(options.provider.statusPageUrl === undefined
			? {}
			: { statusPageUrl: options.provider.statusPageUrl }),
		...(document.page?.updated_at === undefined
			? {}
			: { upstreamUpdatedAt: document.page.updated_at }),
		components: selection.components,
		incidents,
	};
}

export function mapStatuspageComponentStatus(status: string | undefined): ProviderStatus {
	if (status === undefined) return "unknown";
	return STATUSPAGE_COMPONENT_STATUS[status] ?? "unknown";
}

async function fetchSplitStatuspageDocument(
	fetchImplementation: typeof globalThis.fetch,
	options: Extract<StatuspageProviderOptions, { statusUrl: string }>,
	signal: AbortSignal,
	maxResponseBytes: number,
): Promise<StatuspageSummaryDocument> {
	const [status, components, incidents] = await Promise.all([
		fetchStatuspageDocument(
			fetchImplementation,
			options.statusUrl,
			signal,
			options.headers,
			maxResponseBytes,
		),
		fetchStatuspageDocument(
			fetchImplementation,
			options.componentsUrl,
			signal,
			options.headers,
			maxResponseBytes,
		),
		fetchStatuspageDocument(
			fetchImplementation,
			options.incidentsUrl,
			signal,
			options.headers,
			maxResponseBytes,
		),
	]);
	return {
		page: status.page ?? incidents.page ?? components.page,
		status: status.status,
		components: components.components,
		incidents: incidents.incidents,
	};
}

async function fetchStatuspageDocument(
	fetchImplementation: typeof globalThis.fetch,
	url: string,
	signal: AbortSignal,
	headers: Readonly<Record<string, string>> | undefined,
	maxResponseBytes: number,
): Promise<StatuspageSummaryDocument> {
	const response = await fetchImplementation(url, {
		method: "GET",
		headers: { accept: "application/json", ...headers },
		cache: "no-store",
		signal,
	});
	if (!response.ok) throw new Error(`Provider status endpoint returned HTTP ${response.status}.`);
	const value: unknown = JSON.parse(await readBoundedBody(response, maxResponseBytes));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Provider status endpoint returned a non-object document.");
	}
	return value;
}

async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
		throw new Error("Provider status endpoint response exceeded the configured size limit.");
	}
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let receivedBytes = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		receivedBytes += result.value.byteLength;
		if (receivedBytes > maxResponseBytes) {
			await reader.cancel();
			throw new Error("Provider status endpoint response exceeded the configured size limit.");
		}
		chunks.push(decoder.decode(result.value, { stream: true }));
	}
	chunks.push(decoder.decode());
	return chunks.join("");
}

function selectComponents(
	components: readonly StatuspageComponent[],
	matchers: readonly StatuspageComponentMatcher[] | undefined,
): NormalizedStatuspageSelection {
	const selected = components.filter((component) => {
		if (component.group === true) return false;
		if (matchers === undefined) return true;
		return matchers.some((matcher) => matchesComponent(component, matcher));
	});
	return {
		components: selected.map((component) => ({
			id: component.id,
			name: component.name,
			status: mapStatuspageComponentStatus(component.status),
			...(component.description == null ? {} : { description: component.description }),
		})),
		componentIds: new Set(selected.map((component) => component.id)),
	};
}

function matchesComponent(
	component: StatuspageComponent,
	matcher: StatuspageComponentMatcher,
): boolean {
	if (typeof matcher === "function") return matcher(component);
	if (typeof matcher === "string") return component.id === matcher || component.name === matcher;
	matcher.lastIndex = 0;
	const matches = matcher.test(component.name);
	matcher.lastIndex = 0;
	return matches;
}

function normalizeIncidents(
	incidents: readonly StatuspageIncident[],
	selection: NormalizedStatuspageSelection,
	hasComponentFilter: boolean,
	maxIncidents: number,
	includeUnscopedIncidents: boolean,
): ProviderStatusIncident[] {
	return incidents
		.filter((incident) => incident.status !== "resolved" && incident.status !== "postmortem")
		.filter((incident) => {
			if (!hasComponentFilter) return true;
			const components = incident.components ?? [];
			if (components.length === 0) return includeUnscopedIncidents;
			return components.some(
				(component) => component.id !== undefined && selection.componentIds.has(component.id),
			);
		})
		.slice(0, Math.max(0, maxIncidents))
		.map((incident, index) => ({
			id: incident.id ?? `incident-${index + 1}`,
			name: incident.name ?? "Provider incident",
			status: incident.status ?? "unknown",
			...(incident.impact === undefined ? {} : { impact: incident.impact }),
			...(incident.updated_at === undefined ? {} : { updatedAt: incident.updated_at }),
			...(incident.shortlink === undefined ? {} : { url: incident.shortlink }),
			components: (incident.components ?? []).flatMap((component) =>
				component.name === undefined ? [] : [component.name],
			),
		}));
}

function selectionStatus(
	selection: NormalizedStatuspageSelection,
	pageIndicator: string | undefined,
): ProviderStatus {
	if (selection.components.length === 0) return mapStatuspageIndicator(pageIndicator);
	const statuses = selection.components.map((component) => component.status);
	const worst = worstProviderStatus(statuses);
	return worst === "operational" && statuses.includes("unknown") ? "unknown" : worst;
}

function mapStatuspageIndicator(indicator: string | undefined): ProviderStatus {
	if (indicator === undefined) return "unknown";
	return STATUSPAGE_INDICATOR_STATUS[indicator] ?? "unknown";
}

function invalidDocument(providerId: string): ProviderStatusError {
	return new ProviderStatusError(
		"INVALID_REPORT",
		`Provider "${providerId}" returned an invalid Statuspage document.`,
		{ providerId },
	);
}
