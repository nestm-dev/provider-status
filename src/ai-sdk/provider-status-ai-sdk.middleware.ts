import { APICallError, RetryError, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { ProviderStatusError } from "../core/index.ts";
import type {
	AiSdkProviderFailureClassification,
	AiSdkProviderModelContext,
	MonitorableLanguageModel,
	MonitoredLanguageModel,
	ProviderStatusAiSdkMiddlewareOptions,
	ProviderStatusRecorder,
} from "./provider-status-ai-sdk.types.ts";

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type WrapStreamOptions = Parameters<WrapStream>[0];
type AiStreamResult = Awaited<ReturnType<WrapStreamOptions["doStream"]>>;
type AiStreamPart = AiStreamResult["stream"] extends ReadableStream<infer PART> ? PART : never;

export function createProviderStatusMiddleware(
	monitor: ProviderStatusRecorder,
	options: ProviderStatusAiSdkMiddlewareOptions = {},
): LanguageModelMiddleware {
	return {
		wrapGenerate: async ({ doGenerate, model }) => {
			const providerId = resolveRegisteredProvider(monitor, model, options);
			if (providerId === undefined) return doGenerate();
			assertConfiguredAvailability(monitor, providerId, options);
			const started = performance.now();
			let result: Awaited<ReturnType<typeof doGenerate>>;
			try {
				result = await doGenerate();
			} catch (error) {
				safelyReportAiSdkFailure(monitor, providerId, model.modelId, started, error, options);
				throw error;
			}
			safelyReportAiSdkSuccess(monitor, providerId, model.modelId, started);
			return result;
		},
		wrapStream: async ({ doStream, model }) => {
			const providerId = resolveRegisteredProvider(monitor, model, options);
			if (providerId === undefined) return doStream();
			assertConfiguredAvailability(monitor, providerId, options);
			const started = performance.now();
			try {
				const result = await doStream();
				return {
					...result,
					stream: monitorAiStream(result.stream, {
						onSuccess: () => safelyReportAiSdkSuccess(monitor, providerId, model.modelId, started),
						onFailure: (error) =>
							safelyReportAiSdkFailure(monitor, providerId, model.modelId, started, error, options),
					}),
				};
			} catch (error) {
				safelyReportAiSdkFailure(monitor, providerId, model.modelId, started, error, options);
				throw error;
			}
		},
	};
}

export function monitorLanguageModel(
	model: MonitorableLanguageModel,
	monitor: ProviderStatusRecorder,
	options: ProviderStatusAiSdkMiddlewareOptions = {},
): MonitoredLanguageModel {
	return wrapLanguageModel({
		model,
		middleware: createProviderStatusMiddleware(monitor, options),
	});
}

export function resolveAiSdkProviderStatusId(
	context: AiSdkProviderModelContext,
	options: Pick<
		ProviderStatusAiSdkMiddlewareOptions,
		"providerId" | "providerMap" | "resolveProviderId"
	> = {},
): string | undefined {
	if (options.providerId !== undefined) return options.providerId;
	const custom = options.resolveProviderId?.(context);
	if (custom !== undefined) return custom;
	const exact = options.providerMap?.[context.provider];
	if (exact !== undefined) return exact;

	const providerRoot =
		context.provider.toLowerCase().split(/[.:/]/, 1)[0] ?? context.provider.toLowerCase();
	if (providerRoot === "gateway") {
		const gatewayProvider = context.modelId.toLowerCase().split("/", 1)[0];
		if (gatewayProvider === undefined) return undefined;
		return options.providerMap?.[gatewayProvider] ?? gatewayProvider;
	}
	return options.providerMap?.[providerRoot] ?? providerRoot;
}

export function classifyAiSdkProviderError(error: unknown): AiSdkProviderFailureClassification {
	const unwrapped = unwrapRetryError(error);
	if (APICallError.isInstance(unwrapped)) {
		const statusCode = unwrapped.statusCode;
		if (statusCode === 429) {
			return {
				kind: "rate-limit",
				affectsStatus: false,
				classification: "rate-limit",
				statusCode,
			};
		}
		if (statusCode === 401 || statusCode === 403) {
			return {
				kind: "auth",
				affectsStatus: false,
				classification: "auth",
				statusCode,
			};
		}
		if (statusCode === 402) {
			return {
				kind: "billing",
				affectsStatus: false,
				classification: "billing",
				statusCode,
			};
		}
		if (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
			return {
				kind: "configuration",
				affectsStatus: false,
				classification: "configuration",
				statusCode,
			};
		}
		if (statusCode === 408) {
			return { kind: "timeout", affectsStatus: true, classification: "timeout", statusCode };
		}
		if (statusCode !== undefined && statusCode >= 500) {
			return {
				kind: "provider-availability",
				affectsStatus: true,
				classification: "transient",
				statusCode,
			};
		}
		return {
			kind: unwrapped.isRetryable ? "network" : "unknown",
			affectsStatus: unwrapped.isRetryable,
			classification: unwrapped.isRetryable ? "network" : "unknown",
			...(statusCode === undefined ? {} : { statusCode }),
		};
	}

	if (isNamedError(unwrapped, "AbortError")) {
		return { kind: "cancelled", affectsStatus: false, classification: "cancelled" };
	}
	if (isNamedError(unwrapped, "TimeoutError")) {
		return { kind: "timeout", affectsStatus: true, classification: "timeout" };
	}
	if (isLikelyNetworkError(unwrapped)) {
		return { kind: "network", affectsStatus: true, classification: "network" };
	}
	return { kind: "unknown", affectsStatus: false, classification: "unknown" };
}

function unwrapRetryError(error: unknown): unknown {
	let current = error;
	const seen = new Set<unknown>();
	while (RetryError.isInstance(current) && !seen.has(current)) {
		seen.add(current);
		current = current.lastError;
	}
	return current;
}

function resolveRegisteredProvider(
	monitor: ProviderStatusRecorder,
	context: AiSdkProviderModelContext,
	options: ProviderStatusAiSdkMiddlewareOptions,
): string | undefined {
	let providerId: string | undefined;
	try {
		providerId = resolveAiSdkProviderStatusId(context, options);
		if (providerId !== undefined && monitor.has(providerId)) return providerId;
	} catch (error) {
		if (options.onUnknownProvider === "throw") throw error;
		return undefined;
	}
	if (options.onUnknownProvider === "throw") {
		throw new ProviderStatusError(
			"UNKNOWN_PROVIDER",
			`AI SDK model provider "${providerId ?? context.provider}" is not registered for status monitoring.`,
			{ providerId: providerId ?? context.provider },
		);
	}
	return undefined;
}

function assertConfiguredAvailability(
	monitor: ProviderStatusRecorder,
	providerId: string,
	options: ProviderStatusAiSdkMiddlewareOptions,
): void {
	if (options.availability !== undefined && options.availability !== false) {
		monitor.assertAvailable(providerId, options.availability);
	}
}

function safelyReportAiSdkSuccess(
	monitor: ProviderStatusRecorder,
	providerId: string,
	modelId: string,
	started: number,
): void {
	try {
		monitor.reportSuccess(providerId, {
			latencyMs: performance.now() - started,
			modelId,
		});
	} catch {
		// Advisory instrumentation must never replace a successful provider result.
	}
}

function safelyReportAiSdkFailure(
	monitor: ProviderStatusRecorder,
	providerId: string,
	modelId: string,
	started: number,
	error: unknown,
	options: ProviderStatusAiSdkMiddlewareOptions,
): void {
	try {
		const classification = (options.classifyError ?? classifyAiSdkProviderError)(error);
		monitor.reportFailure(providerId, {
			latencyMs: performance.now() - started,
			modelId,
			affectsStatus: classification.affectsStatus,
			classification: classification.classification,
			...(classification.statusCode === undefined ? {} : { statusCode: classification.statusCode }),
		});
	} catch {
		// Preserve the original provider failure even if advisory instrumentation fails.
	}
}

function monitorAiStream(
	stream: ReadableStream<AiStreamPart>,
	callbacks: { readonly onSuccess: () => void; readonly onFailure: (error: unknown) => void },
): ReadableStream<AiStreamPart> {
	const reader = stream.getReader();
	let terminalRecorded = false;
	return new ReadableStream<AiStreamPart>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					controller.close();
					return;
				}
				const part = result.value;
				if (!terminalRecorded && part.type === "error") {
					terminalRecorded = true;
					callbacks.onFailure(part.error);
				} else if (!terminalRecorded && part.type === "finish") {
					terminalRecorded = true;
					callbacks.onSuccess();
				}
				controller.enqueue(part);
			} catch (error) {
				if (!terminalRecorded) {
					terminalRecorded = true;
					callbacks.onFailure(error);
				}
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason);
		},
	});
}

function isNamedError(error: unknown, name: string): boolean {
	return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function isLikelyNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : "";
	return /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|ETIMEDOUT)$/.test(code);
}
