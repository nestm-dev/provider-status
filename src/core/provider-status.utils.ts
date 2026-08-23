import type {
	ProviderStatus,
	ProviderStatusAvailabilityOptions,
	ProviderStatusHealth,
} from "./provider-status.types.ts";

const STATUS_ORDER: Readonly<Record<ProviderStatus, number>> = {
	unknown: 0,
	operational: 1,
	degraded: 2,
	maintenance: 3,
	down: 4,
};

export function isProviderStatus(value: unknown): value is ProviderStatus {
	return (
		value === "operational" ||
		value === "degraded" ||
		value === "down" ||
		value === "maintenance" ||
		value === "unknown"
	);
}

/** Returns the worst known status. Unknown wins only when no known signal exists. */
export function worstProviderStatus(statuses: readonly ProviderStatus[]): ProviderStatus {
	const known = statuses.filter((status) => status !== "unknown");
	if (known.length === 0) return "unknown";
	return known.reduce((worst, status) =>
		STATUS_ORDER[status] > STATUS_ORDER[worst] ? status : worst,
	);
}

export function isProviderAvailable(
	health: ProviderStatusHealth,
	options: ProviderStatusAvailabilityOptions = {},
): boolean {
	const activeSignals: ProviderStatus[] = [];
	if (!health.stale && health.reportedStatus !== null) activeSignals.push(health.reportedStatus);
	if (health.observedStatus !== "unknown") activeSignals.push(health.observedStatus);
	if (activeSignals.length === 0) activeSignals.push("unknown");
	return activeSignals.every((status) => isStatusAvailable(status, options));
}

function isStatusAvailable(
	status: ProviderStatus,
	options: ProviderStatusAvailabilityOptions,
): boolean {
	const allowDegraded = options.allowDegraded ?? true;
	const allowMaintenance = options.allowMaintenance ?? false;
	const allowUnknown = options.allowUnknown ?? true;

	switch (status) {
		case "operational":
			return true;
		case "degraded":
			return allowDegraded;
		case "maintenance":
			return allowMaintenance;
		case "unknown":
			return allowUnknown;
		case "down":
			return false;
	}
	return false;
}

export function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function percentile(values: readonly number[], quantile: number): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((left, right) => left - right);
	const index = Math.ceil(quantile * sorted.length) - 1;
	return sorted[clamp(index, 0, sorted.length - 1)] ?? null;
}
