import type { LanguageModel, LanguageModelMiddleware } from "ai";
import type {
	ProviderStatusAvailabilityOptions,
	ProviderStatusMonitor,
	ProviderStatusObservationClassification,
} from "../core/index.ts";

export interface AiSdkProviderModelContext {
	readonly provider: string;
	readonly modelId: string;
}

export type AiSdkProviderStatusResolver = (
	context: AiSdkProviderModelContext,
) => string | undefined;

export type AiSdkProviderFailureKind =
	| "provider-availability"
	| "rate-limit"
	| "auth"
	| "billing"
	| "configuration"
	| "timeout"
	| "cancelled"
	| "network"
	| "unknown";

export interface AiSdkProviderFailureClassification {
	readonly kind: AiSdkProviderFailureKind;
	readonly affectsStatus: boolean;
	readonly classification: ProviderStatusObservationClassification;
	readonly statusCode?: number;
}

export interface ProviderStatusAiSdkMiddlewareOptions {
	/** Fixed monitored provider id. Prefer this when wrapping one concrete model. */
	readonly providerId?: string;
	/** Exact/raw provider aliases applied before the default resolver. */
	readonly providerMap?: Readonly<Record<string, string>>;
	/** Custom model-to-monitor mapping. It takes precedence over `providerMap`. */
	readonly resolveProviderId?: AiSdkProviderStatusResolver;
	/** What to do when the resolved id is not registered. Defaults to ignore. */
	readonly onUnknownProvider?: "ignore" | "throw";
	/**
	 * Optional pre-call availability gate. It is disabled by default: monitoring
	 * is advisory and never blocks AI calls unless this is configured.
	 */
	readonly availability?: false | ProviderStatusAvailabilityOptions;
	readonly classifyError?: (error: unknown) => AiSdkProviderFailureClassification;
}

export type ProviderStatusRecorder = Pick<
	ProviderStatusMonitor,
	"assertAvailable" | "has" | "reportFailure" | "reportSuccess"
>;

export type MonitorableLanguageModel = Parameters<
	typeof import("ai").wrapLanguageModel
>[0]["model"];

export type MonitoredLanguageModel = ReturnType<typeof import("ai").wrapLanguageModel>;

export type ProviderStatusLanguageModelMiddleware = LanguageModelMiddleware;

export type ProviderStatusLanguageModel = LanguageModel;
