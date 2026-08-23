import { APICallError, RetryError, type LanguageModelMiddleware } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatusError, type ProviderStatusHealth } from "../../src/core/index.ts";
import {
	classifyAiSdkProviderError,
	createProviderStatusMiddleware,
	monitorLanguageModel,
	resolveAiSdkProviderStatusId,
	type ProviderStatusRecorder,
} from "../../src/ai-sdk/index.ts";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer PART> ? PART : never;
type ModelCallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const MODEL_CALL_OPTIONS: ModelCallOptions = { prompt: [] };
const LANGUAGE_USAGE = {
	inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function generateResult(text = "generated"): GenerateResult {
	return {
		content: [{ type: "text", text }],
		finishReason: { unified: "stop", raw: undefined },
		usage: LANGUAGE_USAGE,
		warnings: [],
	};
}

function streamResult(parts: readonly StreamPart[]): StreamResult {
	return { stream: simulateReadableStream({ chunks: [...parts] }) };
}

function finishedStream(text = "streamed"): StreamResult {
	return streamResult([
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: text },
		{ type: "text-end", id: "text" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			usage: LANGUAGE_USAGE,
		},
	]);
}

function providerHealth(id: string): ProviderStatusHealth {
	return {
		id,
		name: id,
		status: "operational",
		reportedStatus: null,
		observedStatus: "operational",
		sourceState: "not-configured",
		stale: false,
		components: [],
		incidents: [],
		observations: {
			status: "operational",
			sampleCount: 1,
			successCount: 1,
			failureCount: 0,
			ignoredFailureCount: 0,
			consecutiveFailures: 0,
			consecutiveSuccesses: 1,
			errorRate: 0,
			latencyMs: { last: 1, p50: 1, p95: 1 },
		},
	};
}

function recorderFixture(registeredIds: readonly string[] = ["openai"]) {
	const registered = new Set(registeredIds);
	const has = vi.fn<ProviderStatusRecorder["has"]>((providerId) => registered.has(providerId));
	const assertAvailable = vi.fn<ProviderStatusRecorder["assertAvailable"]>((providerId) =>
		providerHealth(providerId),
	);
	const reportFailure = vi.fn<ProviderStatusRecorder["reportFailure"]>();
	const reportSuccess = vi.fn<ProviderStatusRecorder["reportSuccess"]>();
	const recorder: ProviderStatusRecorder = {
		has,
		assertAvailable,
		reportFailure,
		reportSuccess,
	};
	return { recorder, has, assertAvailable, reportFailure, reportSuccess };
}

function apiCallError(statusCode?: number, isRetryable?: boolean): APICallError {
	return new APICallError({
		message: "provider failed",
		url: "https://api.example.test/v1/messages",
		requestBodyValues: {},
		...(statusCode === undefined ? {} : { statusCode }),
		...(isRetryable === undefined ? {} : { isRetryable }),
	});
}

async function readStream(stream: ReadableStream<StreamPart>): Promise<StreamPart[]> {
	const parts: StreamPart[] = [];
	for await (const part of stream) parts.push(part);
	return parts;
}

describe("AI SDK provider status middleware", () => {
	it("resolves fixed, custom, exact, root, and gateway provider ids in precedence order", () => {
		const context = { provider: "openai.responses", modelId: "gpt-5" };
		expect(resolveAiSdkProviderStatusId(context)).toBe("openai");
		expect(
			resolveAiSdkProviderStatusId(context, { providerMap: { "openai.responses": "exact" } }),
		).toBe("exact");
		expect(resolveAiSdkProviderStatusId(context, { providerMap: { openai: "root" } })).toBe("root");
		expect(
			resolveAiSdkProviderStatusId(context, {
				providerMap: { "openai.responses": "mapped" },
				resolveProviderId: () => "custom",
			}),
		).toBe("custom");
		expect(
			resolveAiSdkProviderStatusId(context, {
				providerId: "fixed",
				resolveProviderId: () => "custom",
			}),
		).toBe("fixed");
		expect(
			resolveAiSdkProviderStatusId(
				{ provider: "gateway", modelId: "anthropic/claude-sonnet" },
				{ providerMap: { anthropic: "claude" } },
			),
		).toBe("claude");
	});

	it.each([
		[429, "rate-limit", false, "rate-limit"],
		[401, "auth", false, "auth"],
		[403, "auth", false, "auth"],
		[402, "billing", false, "billing"],
		[400, "configuration", false, "configuration"],
		[409, "configuration", false, "configuration"],
		[408, "timeout", true, "timeout"],
		[503, "provider-availability", true, "transient"],
	] as const)("classifies HTTP %i as %s", (statusCode, kind, affectsStatus, classification) => {
		expect(classifyAiSdkProviderError(apiCallError(statusCode))).toEqual({
			kind,
			affectsStatus,
			classification,
			statusCode,
		});
	});

	it("classifies retry wrappers, cancellations, timeouts, network errors, and unknown errors", () => {
		const retryError = new RetryError({
			message: "retries exhausted",
			reason: "maxRetriesExceeded",
			errors: [apiCallError(503)],
		});
		const networkError = Object.assign(new Error("reset"), { code: "ECONNRESET" });

		expect(classifyAiSdkProviderError(retryError)).toMatchObject({
			kind: "provider-availability",
			statusCode: 503,
		});
		expect(classifyAiSdkProviderError(new DOMException("cancelled", "AbortError"))).toEqual({
			kind: "cancelled",
			affectsStatus: false,
			classification: "cancelled",
		});
		expect(classifyAiSdkProviderError(new DOMException("late", "TimeoutError"))).toEqual({
			kind: "timeout",
			affectsStatus: true,
			classification: "timeout",
		});
		expect(classifyAiSdkProviderError(networkError)).toEqual({
			kind: "network",
			affectsStatus: true,
			classification: "network",
		});
		expect(classifyAiSdkProviderError(new Error("unexpected"))).toEqual({
			kind: "unknown",
			affectsStatus: false,
			classification: "unknown",
		});
		expect(classifyAiSdkProviderError(apiCallError(undefined, true))).toEqual({
			kind: "network",
			affectsStatus: true,
			classification: "network",
		});
	});

	it("records successful generated calls for a registered provider", async () => {
		const fixture = recorderFixture();
		const model = new MockLanguageModelV4({
			provider: "openai.responses",
			modelId: "gpt-test",
			doGenerate: generateResult(),
		});
		const monitored = monitorLanguageModel(model, fixture.recorder);

		const result = await monitored.doGenerate(MODEL_CALL_OPTIONS);

		expect(result.content).toEqual([{ type: "text", text: "generated" }]);
		expect(fixture.has).toHaveBeenCalledWith("openai");
		expect(fixture.reportFailure).not.toHaveBeenCalled();
		expect(fixture.reportSuccess).toHaveBeenCalledOnce();
		const [providerId, details] = fixture.reportSuccess.mock.calls[0] ?? [];
		expect(providerId).toBe("openai");
		expect(details?.modelId).toBe("gpt-test");
		expect(details?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("records classified generated-call failures and rethrows the original error", async () => {
		const fixture = recorderFixture();
		const providerError = apiCallError(503);
		const model = new MockLanguageModelV4({
			provider: "openai.chat",
			modelId: "gpt-failing",
			doGenerate: async () => {
				throw providerError;
			},
		});
		const monitored = monitorLanguageModel(model, fixture.recorder);

		await expect(monitored.doGenerate(MODEL_CALL_OPTIONS)).rejects.toBe(providerError);
		expect(fixture.reportSuccess).not.toHaveBeenCalled();
		expect(fixture.reportFailure).toHaveBeenCalledOnce();
		const [providerId, details] = fixture.reportFailure.mock.calls[0] ?? [];
		expect(providerId).toBe("openai");
		expect(details).toMatchObject({
			modelId: "gpt-failing",
			statusCode: 503,
			affectsStatus: true,
			classification: "transient",
		});
		expect(details?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("ignores unknown providers by default and can fail closed on demand", async () => {
		const ignored = recorderFixture([]);
		const doGenerate = vi.fn(async () => generateResult("unmonitored"));
		const model = new MockLanguageModelV4({
			provider: "unregistered.chat",
			modelId: "custom-model",
			doGenerate,
		});

		const result = await monitorLanguageModel(model, ignored.recorder).doGenerate(
			MODEL_CALL_OPTIONS,
		);
		expect(result.content).toEqual([{ type: "text", text: "unmonitored" }]);
		expect(doGenerate).toHaveBeenCalledOnce();
		expect(ignored.reportSuccess).not.toHaveBeenCalled();

		const strict = monitorLanguageModel(model, ignored.recorder, { onUnknownProvider: "throw" });
		await expect(strict.doGenerate(MODEL_CALL_OPTIONS)).rejects.toMatchObject({
			code: "UNKNOWN_PROVIDER",
			providerId: "unregistered",
		});
		expect(doGenerate).toHaveBeenCalledOnce();
	});

	it("runs the opt-in availability gate before calling the model", async () => {
		const fixture = recorderFixture();
		const unavailable = new ProviderStatusError("PROVIDER_UNAVAILABLE", "Provider is down.", {
			providerId: "openai",
			status: "down",
		});
		fixture.assertAvailable.mockImplementationOnce(() => {
			throw unavailable;
		});
		const doGenerate = vi.fn(async () => generateResult());
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "gpt-gated",
			doGenerate,
		});
		const monitored = monitorLanguageModel(model, fixture.recorder, {
			availability: { allowDegraded: false, allowUnknown: false },
		});

		await expect(monitored.doGenerate(MODEL_CALL_OPTIONS)).rejects.toBe(unavailable);
		expect(fixture.assertAvailable).toHaveBeenCalledWith("openai", {
			allowDegraded: false,
			allowUnknown: false,
		});
		expect(doGenerate).not.toHaveBeenCalled();
		expect(fixture.reportFailure).not.toHaveBeenCalled();
	});

	it("uses a custom failure classifier", async () => {
		const fixture = recorderFixture();
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "custom-classifier",
			doGenerate: async () => {
				throw new Error("custom failure");
			},
		});
		const classifyError = vi.fn(() => ({
			kind: "billing" as const,
			affectsStatus: false,
			classification: "billing" as const,
			statusCode: 402,
		}));
		const monitored = monitorLanguageModel(model, fixture.recorder, { classifyError });

		await expect(monitored.doGenerate(MODEL_CALL_OPTIONS)).rejects.toThrow("custom failure");
		expect(classifyError).toHaveBeenCalledOnce();
		expect(fixture.reportFailure).toHaveBeenCalledWith(
			"openai",
			expect.objectContaining({
				statusCode: 402,
				affectsStatus: false,
				classification: "billing",
			}),
		);
	});

	it("never lets advisory recorder failures replace model results or provider errors", async () => {
		const successfulFixture = recorderFixture();
		successfulFixture.reportSuccess.mockImplementationOnce(() => {
			throw new Error("recorder unavailable");
		});
		const successfulModel = new MockLanguageModelV4({
			provider: "openai",
			modelId: "successful-model",
			doGenerate: generateResult("preserved"),
		});

		const result = await monitorLanguageModel(
			successfulModel,
			successfulFixture.recorder,
		).doGenerate(MODEL_CALL_OPTIONS);
		expect(result.content).toEqual([{ type: "text", text: "preserved" }]);

		const failedFixture = recorderFixture();
		const providerError = new Error("original provider error");
		const failedModel = new MockLanguageModelV4({
			provider: "openai",
			modelId: "failed-model",
			doGenerate: async () => {
				throw providerError;
			},
		});
		const monitored = monitorLanguageModel(failedModel, failedFixture.recorder, {
			classifyError: () => {
				throw new Error("classifier unavailable");
			},
		});

		await expect(monitored.doGenerate(MODEL_CALL_OPTIONS)).rejects.toBe(providerError);
		expect(failedFixture.reportFailure).not.toHaveBeenCalled();
	});

	it("ignores resolver and registry failures in advisory mode", async () => {
		const fixture = recorderFixture();
		fixture.has.mockImplementationOnce(() => {
			throw new Error("registry unavailable");
		});
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "advisory-model",
			doGenerate: generateResult("still generated"),
		});

		const result = await monitorLanguageModel(model, fixture.recorder).doGenerate(
			MODEL_CALL_OPTIONS,
		);

		expect(result.content).toEqual([{ type: "text", text: "still generated" }]);
		expect(fixture.reportSuccess).not.toHaveBeenCalled();
	});

	it("records streamed success only when the finish part is consumed", async () => {
		const fixture = recorderFixture();
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "gpt-stream",
			doStream: finishedStream(),
		});
		const monitored = monitorLanguageModel(model, fixture.recorder);

		const result = await monitored.doStream(MODEL_CALL_OPTIONS);
		expect(fixture.reportSuccess).not.toHaveBeenCalled();
		const parts = await readStream(result.stream);

		expect(parts.at(-1)?.type).toBe("finish");
		expect(fixture.reportSuccess).toHaveBeenCalledOnce();
		expect(fixture.reportSuccess.mock.calls[0]?.[1]?.modelId).toBe("gpt-stream");
		expect(fixture.reportFailure).not.toHaveBeenCalled();
	});

	it("records one streamed failure from an error part and preserves the stream", async () => {
		const fixture = recorderFixture();
		const providerError = apiCallError(429);
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "gpt-stream-error",
			doStream: streamResult([
				{ type: "stream-start", warnings: [] },
				{ type: "error", error: providerError },
				{
					type: "finish",
					finishReason: { unified: "error", raw: undefined },
					usage: LANGUAGE_USAGE,
				},
			]),
		});

		const result = await monitorLanguageModel(model, fixture.recorder).doStream(MODEL_CALL_OPTIONS);
		const parts = await readStream(result.stream);

		expect(parts.map((part) => part.type)).toEqual(["stream-start", "error", "finish"]);
		expect(fixture.reportFailure).toHaveBeenCalledOnce();
		expect(fixture.reportFailure).toHaveBeenCalledWith(
			"openai",
			expect.objectContaining({
				statusCode: 429,
				affectsStatus: false,
				classification: "rate-limit",
			}),
		);
		expect(fixture.reportSuccess).not.toHaveBeenCalled();
	});

	it("records synchronous stream setup failures and rethrows them", async () => {
		const fixture = recorderFixture();
		const failure = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		const model = new MockLanguageModelV4({
			provider: "openai",
			modelId: "gpt-no-stream",
			doStream: async () => {
				throw failure;
			},
		});

		await expect(
			monitorLanguageModel(model, fixture.recorder).doStream(MODEL_CALL_OPTIONS),
		).rejects.toBe(failure);
		expect(fixture.reportFailure).toHaveBeenCalledWith(
			"openai",
			expect.objectContaining({ affectsStatus: true, classification: "network" }),
		);
	});

	it("exposes a V4-compatible middleware object", () => {
		const fixture = recorderFixture();
		const middleware: LanguageModelMiddleware = createProviderStatusMiddleware(fixture.recorder);

		expect(middleware.wrapGenerate).toBeTypeOf("function");
		expect(middleware.wrapStream).toBeTypeOf("function");
	});
});
