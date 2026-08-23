export type ProviderStatus = "operational" | "degraded" | "down" | "maintenance" | "unknown";

export type ProviderStatusSourceState =
	"not-configured" | "pending" | "available" | "unavailable" | "stale";

export interface ProviderStatusComponent {
	readonly id: string;
	readonly name: string;
	readonly status: ProviderStatus;
	readonly description?: string;
}

export interface ProviderStatusIncident {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly impact?: string;
	readonly updatedAt?: string;
	readonly url?: string;
	readonly components: readonly string[];
}

/** A provider-owned, safe-to-display result from one public status check. */
export interface ProviderStatusReport {
	readonly status: ProviderStatus;
	readonly description?: string;
	readonly statusPageUrl?: string;
	readonly upstreamUpdatedAt?: string;
	readonly components?: readonly ProviderStatusComponent[];
	readonly incidents?: readonly ProviderStatusIncident[];
}

export interface ProviderStatusCheckContext {
	readonly signal: AbortSignal;
	readonly checkedAt: string;
}

/**
 * One monitored provider. Omit `check` for a passive-only provider whose
 * health is derived exclusively from runtime observations.
 */
export interface ProviderStatusProvider {
	readonly id: string;
	readonly name: string;
	readonly statusPageUrl?: string;
	readonly check?: (
		context: ProviderStatusCheckContext,
	) => ProviderStatusReport | PromiseLike<ProviderStatusReport>;
}

export type ProviderStatusObservationClassification =
	| "transient"
	| "permanent"
	| "rate-limit"
	| "auth"
	| "billing"
	| "configuration"
	| "network"
	| "timeout"
	| "cancelled"
	| "unknown";

export interface ProviderStatusObservationDetails {
	readonly latencyMs?: number;
	readonly statusCode?: number;
	readonly modelId?: string;
	readonly at?: string | Date;
	/**
	 * Permanent caller/configuration failures and user cancellations should set
	 * this to false so they remain visible in metrics without degrading health.
	 */
	readonly affectsStatus?: boolean;
	readonly classification?: ProviderStatusObservationClassification;
}

export interface ProviderStatusObservationEvidence {
	readonly at: string;
	readonly latencyMs?: number;
	readonly statusCode?: number;
	readonly modelId?: string;
	readonly affectsStatus: boolean;
	readonly classification?: ProviderStatusObservationClassification;
}

export interface ProviderStatusObservationSummary {
	readonly status: Exclude<ProviderStatus, "maintenance">;
	readonly sampleCount: number;
	readonly successCount: number;
	readonly failureCount: number;
	readonly ignoredFailureCount: number;
	readonly consecutiveFailures: number;
	readonly consecutiveSuccesses: number;
	readonly errorRate: number | null;
	readonly latencyMs: {
		readonly last: number | null;
		readonly p50: number | null;
		readonly p95: number | null;
	};
	readonly lastSuccessAt?: string;
	readonly lastFailureAt?: string;
	readonly lastFailure?: ProviderStatusObservationEvidence;
}

export interface ProviderStatusCheckError {
	readonly code: "CHECK_FAILED" | "CHECK_TIMEOUT" | "INVALID_REPORT";
	readonly message: string;
	readonly at: string;
}

export interface ProviderStatusHealth {
	readonly id: string;
	readonly name: string;
	/** Worst known result across the provider's reported and locally observed signals. */
	readonly status: ProviderStatus;
	readonly reportedStatus: ProviderStatus | null;
	readonly observedStatus: Exclude<ProviderStatus, "maintenance">;
	readonly description?: string;
	readonly statusPageUrl?: string;
	readonly sourceState: ProviderStatusSourceState;
	readonly checkedAt?: string;
	readonly upstreamUpdatedAt?: string;
	readonly stale: boolean;
	readonly lastCheckError?: ProviderStatusCheckError;
	readonly components: readonly ProviderStatusComponent[];
	readonly incidents: readonly ProviderStatusIncident[];
	readonly observations: ProviderStatusObservationSummary;
}

export type ProviderStatusWarningKind =
	| "degraded"
	| "down"
	| "maintenance"
	| "source-unavailable"
	| "stale"
	| "request-error"
	| "unknown";

export interface ProviderStatusWarning {
	readonly id: string;
	readonly providerId: string;
	readonly providerName: string;
	readonly kind: ProviderStatusWarningKind;
	readonly severity: "warning" | "critical";
	readonly message: string;
	readonly statusPageUrl?: string;
	readonly incident?: ProviderStatusIncident;
}

export interface ProviderStatusSnapshot {
	readonly computedAt: string;
	readonly status: ProviderStatus;
	readonly providers: readonly ProviderStatusHealth[];
	readonly warnings: readonly ProviderStatusWarning[];
}

export interface ProviderStatusPollingOptions {
	/** Time between completed polling rounds. Defaults to 60 seconds. */
	readonly intervalMs?: number;
	/** Per-provider source timeout. Defaults to 5 seconds. */
	readonly timeoutMs?: number;
	/** Age after which a retained successful report is stale. Defaults to max(3 intervals, 5 minutes). */
	readonly staleAfterMs?: number;
	/** Random interval variation from 0 through 1. Defaults to 0.1. */
	readonly jitterRatio?: number;
	/** Start polling from the Nest application bootstrap hook. Defaults to true. */
	readonly startOnBootstrap?: boolean;
	/** Do not keep Node.js alive only for the polling timer. Defaults to true. */
	readonly unref?: boolean;
}

export interface ProviderStatusObservationOptions {
	/** Sliding observation window. Defaults to 5 minutes. */
	readonly windowMs?: number;
	/** Maximum retained observations per provider. Defaults to 200. */
	readonly maxSamples?: number;
	/** Samples required before error-rate thresholds apply. Defaults to 10. */
	readonly minimumSamples?: number;
	/** Error rate that produces degraded health. Defaults to 0.2. */
	readonly degradedErrorRate?: number;
	/** Error rate that produces down health. Defaults to 0.5. */
	readonly downErrorRate?: number;
	/** Consecutive failures that immediately produce down health. Defaults to 6. */
	readonly downAfterConsecutiveFailures?: number;
	/** Optional p95 latency threshold. It is disabled by default because model latency varies. */
	readonly degradedLatencyMs?: number;
}

export interface ProviderStatusWarningOptions {
	/** Include checked providers whose fresh result is unknown. Defaults to true. */
	readonly includeUnknown?: boolean;
	/** Warn when the public status source cannot be reached. Defaults to true. */
	readonly includeSourceUnavailable?: boolean;
	/** Warn when the retained public report is stale. Defaults to true. */
	readonly includeStale?: boolean;
	/** Include non-availability request errors such as auth or billing failures. Defaults to true. */
	readonly includeRequestErrors?: boolean;
}

export interface ProviderStatusMonitorOptions {
	readonly providers: readonly ProviderStatusProvider[];
	readonly polling?: false | ProviderStatusPollingOptions;
	readonly observations?: ProviderStatusObservationOptions;
	readonly warnings?: ProviderStatusWarningOptions;
	/** Deterministic clock hook intended for tests and embedded runtimes. */
	readonly clock?: () => number;
	/** Deterministic jitter hook intended for tests and embedded runtimes. */
	readonly random?: () => number;
}

export interface ProviderStatusRefreshOptions {
	readonly signal?: AbortSignal;
}

export interface ProviderStatusAvailabilityOptions {
	/** Whether degraded providers remain usable. Defaults to true. */
	readonly allowDegraded?: boolean;
	/** Whether maintenance remains usable. Defaults to false. */
	readonly allowMaintenance?: boolean;
	/** Whether unknown providers remain usable. Defaults to true. */
	readonly allowUnknown?: boolean;
}
