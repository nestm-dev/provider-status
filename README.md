# @nestm/provider-status

Provider-neutral availability monitoring for **NestJS 12**. The package combines public provider
status feeds with local request observations, exposes immutable snapshots through a service and
RxJS observables, and includes optional dashboard HTTP/SSE and AI SDK integrations.

- Built-in OpenAI API and Claude API status sources
- Generic support for Statuspage-compatible summary or split endpoints
- Application-owned custom and passive providers
- Central polling with timeouts, jitter, stale detection, and non-overlapping checks
- Local success, failure, error-rate, consecutive-failure, and optional latency observations
- Immutable snapshots, provider-specific streams, and warning streams
- Adapter-neutral JSON and Server-Sent Events endpoints for dashboards
- AI SDK language-model middleware that records outcomes without blocking calls by default
- Framework-neutral core and deterministic, network-free testing utilities

Provider status is advisory unless the application explicitly opts into availability enforcement.
The package does not automatically retry, reroute, select fallback models, or fail NestJS readiness.

> This package targets the NestJS 12 prerelease line and is published on the `alpha` dist-tag.

## Architecture and entry points

Each entry point has a narrow dependency boundary:

| Entry point                         | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `@nestm/provider-status`            | NestJS module, lifecycle-aware service, shared types, and utilities  |
| `@nestm/provider-status/core`       | Framework-neutral monitor, contracts, status helpers, and errors     |
| `@nestm/provider-status/statuspage` | Generic Statuspage source plus OpenAI and Anthropic presets          |
| `@nestm/provider-status/http`       | Adapter-neutral Nest controller for dashboard JSON and SSE           |
| `@nestm/provider-status/ai-sdk`     | Optional AI SDK 7 model middleware, resolver, and injectable service |
| `@nestm/provider-status/testing`    | In-memory provider and polling-disabled Nest testing module          |

The root entry point does not load `ai`, Express, Fastify, or a concrete provider SDK. The core
entry point has no NestJS imports. Applications own credentials, custom status endpoints, provider
clients, authentication, routing policy, and persistent telemetry.

## Requirements

- Node.js 22.12 or newer
- NestJS `^12.0.0-alpha.5`
- RxJS `^7.8`
- ESM

## Installation

```sh
pnpm add @nestm/provider-status@alpha @nestjs/common @nestjs/core reflect-metadata rxjs
```

Install AI SDK 7 only when using the optional AI integration:

```sh
pnpm add ai
```

The HTTP entry point uses Nest's platform-neutral controller APIs. It does not add Express or
Fastify as a peer dependency; use whichever Nest HTTP adapter the application already owns.

NestJS 12 alpha packages may temporarily declare older sibling peer ranges. If a package manager
rejects Nest's own prerelease peers, use the equivalent peer override until upstream ranges are
widened.

## Quick start

Register the built-in API sources once in the application root:

```ts
import { Module } from "@nestjs/common";
import { ProviderStatusModule } from "@nestm/provider-status";
import {
	createAnthropicStatusProvider,
	createOpenAIStatusProvider,
} from "@nestm/provider-status/statuspage";

@Module({
	imports: [
		ProviderStatusModule.forRoot({
			providers: [createOpenAIStatusProvider(), createAnthropicStatusProvider()],
			polling: {
				intervalMs: 60_000,
				timeoutMs: 5_000,
				staleAfterMs: 5 * 60_000,
				jitterRatio: 0.1,
			},
		}),
	],
})
export class AppModule {}
```

`ProviderStatusModule` is global by default. Pass `isGlobal: false` when the service should remain
module-local.

Polling starts during Nest application bootstrap by default. The first round runs immediately;
later rounds are scheduled after the previous round finishes. Concurrent refreshes for the same
provider share one in-flight check, so a slow status page cannot create overlapping requests.

## Status model

The normalized provider states are:

- `operational`
- `degraded`
- `down`
- `maintenance`
- `unknown`

Each provider health record keeps two independent signals:

- `reportedStatus`: the last valid public or custom status report;
- `observedStatus`: health inferred from local request outcomes.

The public `status` is the worst usable result across both. `unknown` wins only when no known signal
exists. A failed refresh does not prove that the provider is down: the last report is retained while
`sourceState` becomes `unavailable`, and a separate warning is emitted. Once that retained report is
stale, it remains visible as `reportedStatus` for diagnostics but no longer contributes to the
effective `status`; fresh local observations take over, or the effective state becomes `unknown`.

`sourceState` is one of `not-configured`, `pending`, `available`, `unavailable`, or `stale`. This
separation lets a dashboard say “the last OpenAI report was operational, but the status source is
currently unreachable” instead of presenting a false outage.

Snapshots include safe provider metadata, selected components, unresolved incidents, freshness,
the latest normalized check error, local observation summaries, and warnings. Snapshots and their
provider arrays are frozen before publication.

## Built-in OpenAI and Anthropic sources

```ts
import {
	createAnthropicStatusProvider,
	createOpenAIStatusProvider,
} from "@nestm/provider-status/statuspage";

const openai = createOpenAIStatusProvider();
const anthropic = createAnthropicStatusProvider();
```

The OpenAI preset uses the separate status, components, and incidents endpoints at
`status.openai.com` and selects server-side API components such as Responses, Chat Completions,
embeddings, image generation, audio, files, fine-tuning, Realtime, and Batch. It does **not** claim
to monitor ChatGPT UI availability.

The Anthropic preset uses `status.claude.com` and selects the Claude API component. It does **not**
claim to monitor `claude.ai`, Claude Code, or Claude Cowork.

Both presets accept an application-owned `fetch` implementation and allow component selectors to
be replaced:

```ts
const openai = createOpenAIStatusProvider({
	id: "openai-primary",
	name: "OpenAI production API",
	components: ["Responses", /^Realtime/],
	fetch: instrumentedFetch,
});
```

Strings match an exact component ID or name. Regular expressions and matcher functions are also
supported. A configured selector must match at least one component by default; otherwise the check
is rejected as an invalid report rather than silently monitoring the wrong surface.

Statuspage values are normalized as follows:

| Statuspage value                                  | Provider status |
| ------------------------------------------------- | --------------- |
| `operational`, indicator `none`                   | `operational`   |
| `degraded_performance`, `partial_outage`, `minor` | `degraded`      |
| `major_outage`, indicator `major` or `critical`   | `down`          |
| `under_maintenance`, indicator `maintenance`      | `maintenance`   |
| Missing or unrecognized value                     | `unknown`       |

### Generic Statuspage source

Use a single summary endpoint:

```ts
import { createStatuspageProvider } from "@nestm/provider-status/statuspage";

const provider = createStatuspageProvider({
	id: "acme-cloud",
	name: "Acme Cloud",
	statusPageUrl: "https://status.example.com",
	summaryUrl: "https://status.example.com/api/v2/summary.json",
	components: ["Public API"],
	maxIncidents: 3,
});
```

Or configure the three split Statuspage endpoints with `statusUrl`, `componentsUrl`, and
`incidentsUrl`. `summaryUrl` and the split form are mutually exclusive. `requireComponents`
defaults to `true`, `maxIncidents` defaults to three unresolved incidents, and each JSON response
is limited to 1 MB by default through the configurable `maxResponseBytes` option. When component
filters are active, incidents without component metadata are excluded to avoid attributing an
unrelated product incident to the selected API; set `includeUnscopedIncidents: true` only when that
status page is known to publish globally scoped incidents.

### Providers without Statuspage feeds

Any provider can be monitored through a custom `check`, passive request observations, or both. For
example, the Gemini Developer API does not currently expose a dedicated Statuspage-compatible
public feed. Monitor real AI SDK calls under a `google` provider ID, or supply an authoritative
application-owned check. Do not treat Google Workspace Gemini or a Vertex AI project-health feed as
the Developer API's status unless it is the exact surface the application calls.

## Custom providers

A provider is a small application-owned object. Its `check` method receives a timeout-linked
`AbortSignal` and the ISO timestamp assigned to the attempt:

```ts
import type { ProviderStatusProvider, ProviderStatusReport } from "@nestm/provider-status/core";

export const internalAiProvider: ProviderStatusProvider = {
	id: "internal-ai",
	name: "Internal AI gateway",
	statusPageUrl: "https://status.internal.example/ai",
	async check({ signal }): Promise<ProviderStatusReport> {
		const response = await fetch("https://health.internal.example/ai", {
			headers: { accept: "application/json" },
			signal,
		});
		if (!response.ok) throw new Error(`Health endpoint returned ${response.status}.`);

		const result: unknown = await response.json();
		if (
			typeof result !== "object" ||
			result === null ||
			!("healthy" in result) ||
			typeof result.healthy !== "boolean"
		) {
			throw new Error("Health endpoint returned an invalid document.");
		}
		return {
			status: result.healthy ? "operational" : "degraded",
			...("message" in result && typeof result.message === "string"
				? { description: result.message }
				: {}),
		};
	},
};
```

Only return fields safe for snapshots, dashboards, and SSE clients. Throw when the source itself
cannot be checked; do not translate a network failure into `down` unless it is authoritative
evidence about the monitored provider.

Provider IDs must start with an alphanumeric character and may contain letters, numbers, dots,
underscores, and hyphens. Duplicate IDs fail during monitor construction.

### Passive providers and runtime observations

Omit `check` when health comes only from real application calls:

```ts
ProviderStatusModule.forRoot({
	providers: [{ id: "private-model", name: "Private model service" }],
});
```

Then record outcomes through `ProviderStatusService`:

```ts
const startedAt = performance.now();

try {
	await callPrivateModel();
	providerStatus.reportSuccess("private-model", {
		latencyMs: performance.now() - startedAt,
		modelId: "private-v2",
	});
} catch (error) {
	providerStatus.reportFailure("private-model", {
		latencyMs: performance.now() - startedAt,
		classification: "network",
	});
	throw error;
}
```

Set `affectsStatus: false` for caller cancellation, authentication, billing, quota, invalid input,
or another failure that does not demonstrate provider availability. It remains visible as request
evidence and can produce a warning without degrading aggregate health.

Providers may also be added and removed at runtime with `register()` and `unregister()`. Registering
a checked provider while polling is active triggers an immediate refresh.

## Module configuration

### Synchronous configuration

```ts
ProviderStatusModule.forRoot({
	providers: [openai, anthropic, internalAiProvider],
	polling: {
		intervalMs: 60_000,
		timeoutMs: 5_000,
		staleAfterMs: 5 * 60_000,
		jitterRatio: 0.1,
		startOnBootstrap: true,
		unref: true,
	},
	observations: {
		windowMs: 5 * 60_000,
		maxSamples: 200,
		minimumSamples: 10,
		degradedErrorRate: 0.2,
		downErrorRate: 0.5,
		downAfterConsecutiveFailures: 6,
		degradedLatencyMs: 15_000,
	},
	warnings: {
		includeUnknown: true,
		includeSourceUnavailable: true,
		includeStale: true,
		includeRequestErrors: true,
	},
	isGlobal: true,
});
```

The values above are the defaults except `degradedLatencyMs`, which is disabled unless explicitly
configured because acceptable model latency varies widely. The default stale threshold is the
larger of three polling intervals and five minutes. Set `polling: false` for manual refresh or
passive-only monitoring.

### Asynchronous configuration

`forRootAsync()` supports Nest's `useFactory`, `useClass`, and `useExisting` strategies:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ProviderStatusModule } from "@nestm/provider-status";
import { createStatuspageProvider } from "@nestm/provider-status/statuspage";

@Module({
	imports: [
		ProviderStatusModule.forRootAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: (config: ConfigService) => ({
				providers: [
					createStatuspageProvider({
						id: "company-ai",
						name: "Company AI",
						statusPageUrl: config.getOrThrow("AI_STATUS_PAGE_URL"),
						summaryUrl: config.getOrThrow("AI_STATUS_SUMMARY_URL"),
						components: ["API"],
					}),
				],
				polling: { intervalMs: config.get("AI_STATUS_INTERVAL_MS", 60_000) },
			}),
		}),
	],
})
export class ObservabilityModule {}
```

For class-based configuration, implement `ProviderStatusOptionsFactory` and its
`createProviderStatusOptions()` method.

## Service and Observable API

Inject `ProviderStatusService` for synchronous reads, explicit refreshes, runtime observations, and
reactive streams:

```ts
import { Injectable } from "@nestjs/common";
import { ProviderStatusService } from "@nestm/provider-status";

@Injectable()
export class AiAvailabilityFacade {
	readonly status$ = this.providerStatus.status$;
	readonly warnings$ = this.providerStatus.warnings$;
	readonly openai$ = this.providerStatus.watch("openai");

	constructor(private readonly providerStatus: ProviderStatusService) {}

	snapshot() {
		return this.providerStatus.getSnapshot();
	}

	refreshOpenAI() {
		return this.providerStatus.refresh("openai");
	}
}
```

The main API is:

- `getSnapshot()` — current aggregate status, provider records, and warnings;
- `get(id)` / `has(id)` — inspect registration and current provider health;
- `status$` — emits the current immutable snapshot immediately and on recomputation;
- `warnings$` — emits structurally distinct warning arrays;
- `watch(id)` — provider-specific observable;
- `refresh(id?, { signal? })` — refresh one provider or all providers;
- `reportSuccess()` / `reportFailure()` — add local call evidence;
- `isAvailable()` / `assertAvailable()` — evaluate an explicit availability policy;
- `register()` / `unregister()` — manage application-owned providers dynamically;
- `start()` / `stop()` — manually control polling when bootstrap control is disabled.

Provider check failures are captured as `lastCheckError` and source-state warnings; `refresh()` still
resolves with the recomputed snapshot. Invalid or unknown provider IDs continue to throw typed
`ProviderStatusError` instances.

If the caller-provided `AbortSignal` aborts a refresh, `refresh()` rejects with that cancellation and
leaves provider health unchanged. Lifecycle shutdown cancellation is also health-neutral.

Observation samples expire automatically at the end of the configured sliding window. A passive
provider therefore falls back to `unknown` after its evidence expires; a provider with a fresh
public report falls back to that reported state.

Availability evaluates every fresh reported and observed signal independently. Defaults consider
`operational`, `degraded`, and `unknown` usable; `maintenance` and `down` are unavailable. Override
`allowDegraded`, `allowMaintenance`, and `allowUnknown` for stricter policy. `assertAvailable()`
throws `ProviderStatusError` with code `PROVIDER_UNAVAILABLE` when any active signal is rejected.

## Dashboard HTTP and SSE

Import the optional HTTP module after globally configuring provider status:

```ts
import { Module } from "@nestjs/common";
import { ProviderStatusHttpModule } from "@nestm/provider-status/http";

@Module({
	imports: [ProviderStatusHttpModule],
})
export class StatusDashboardModule {}
```

It exposes:

| Route                           | Response                                 |
| ------------------------------- | ---------------------------------------- |
| `GET /provider-status`          | Aggregate `ProviderStatusSnapshot`       |
| `GET /provider-status/warnings` | Current warning array                    |
| `GET /provider-status/:id`      | One provider health record, or HTTP 404  |
| `GET /provider-status/stream`   | SSE snapshots plus a 15-second heartbeat |

Snapshot events use type `provider-status`, the snapshot's `computedAt` value as the event ID, and
a five-second reconnect hint. Heartbeats use type `provider-status-heartbeat`. JSON responses use
`Cache-Control: no-store`.

The plain HTTP module assumes the globally visible `ProviderStatusService`, which is the default
root configuration. For a locally scoped monitor, attach the configured module directly:

```ts
ProviderStatusHttpModule.register({
	imports: [
		ProviderStatusModule.forRoot({
			providers: [openai, anthropic],
			polling: { intervalMs: 60_000 },
			isGlobal: false,
		}),
	],
});
```

No authentication, authorization, tenant filtering, or CORS policy is installed. Protect these
routes in the application or at the gateway, especially when provider names, incidents, model IDs,
or dependency topology are sensitive. Dashboard clients must render provider and incident text as
untrusted content.

## AI SDK integration

The optional AI SDK entry point wraps language models and records real call outcomes into the same
monitor used by public status sources.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
	type MonitorableLanguageModel,
	ProviderStatusAiSdkModule,
	ProviderStatusAiSdkService,
} from "@nestm/provider-status/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const OPENAI_MODEL = Symbol("OPENAI_MODEL");

@Injectable()
export class SummaryService {
	constructor(
		private readonly providerHealth: ProviderStatusAiSdkService,
		@Inject(OPENAI_MODEL) private readonly model: MonitorableLanguageModel,
	) {}

	async summarize(prompt: string): Promise<string> {
		const model = this.providerHealth.wrap(this.model, {
			providerId: "openai",
		});
		const result = await generateText({ model, prompt });
		return result.text;
	}
}

@Module({
	imports: [ConfigModule, ProviderStatusAiSdkModule],
	providers: [
		{
			provide: OPENAI_MODEL,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				createOpenAI({ apiKey: config.getOrThrow("OPENAI_API_KEY") })("gpt-5-mini"),
		},
		SummaryService,
	],
})
export class AiObservabilityModule {}
```

Applications create and own concrete provider clients. `@ai-sdk/openai` is shown only as a consumer
example and is not installed by this package. `ProviderStatusAiSdkModule` expects the configured
`ProviderStatusService` to be visible, which the global-by-default root module provides.

`ProviderStatusAiSdkService.middleware()` returns a native `LanguageModelMiddleware`; `wrap()` and
`wrapLanguageModel()` return a wrapped model. The framework-neutral `createProviderStatusMiddleware()`
and `monitorLanguageModel()` helpers are also exported.

For `isGlobal: false`, use `ProviderStatusAiSdkModule.register({ imports: [...] })` in the same form
as the HTTP example so Nest can resolve the local `ProviderStatusService`.

### Provider mapping

Resolution uses this order:

1. fixed `providerId`;
2. application `resolveProviderId({ provider, modelId })` callback;
3. exact `providerMap` match;
4. the root of the AI SDK provider string;
5. for AI SDK Gateway models, the first `modelId` segment such as `openai` in
   `openai/gpt-5-mini`.

An unresolved or unregistered provider is ignored by default. Set `onUnknownProvider: "throw"` to
fail when model-to-monitor mapping is required.

```ts
const monitored = providerHealth.wrap(model, {
	providerMap: {
		"openai.responses": "openai",
		anthropic: "anthropic",
	},
	onUnknownProvider: "throw",
});
```

### Advisory versus enforced availability

Monitoring is advisory by default. With no `availability` option, the middleware always attempts the
AI call and only records its outcome. This is deliberate: a public status page can be stale or wrong,
and automatic blocking or fallback can amplify an incident.

To enforce availability before a call, configure the middleware's `availability` policy:

```ts
const enforceAvailability = {
	availability: {
		allowDegraded: false,
		allowMaintenance: false,
		allowUnknown: false,
	},
	onUnknownProvider: "throw",
} as const;

const monitored = providerHealth.wrap(model, {
	providerId: "openai",
	...enforceAvailability,
});
```

This blocks every state except `operational` and throws `ProviderStatusError` before provider I/O.
There is intentionally no automatic retry or fallback behavior. If degraded or unknown providers
should remain usable, set the corresponding flags to `true` or keep advisory mode.

The default error classifier treats provider/network availability evidence separately from caller
and account errors:

- HTTP 5xx, 408, timeouts, and likely network failures affect provider health;
- 429, authentication, billing, ordinary 4xx configuration errors, caller cancellation, and
  otherwise unclassified application errors do not;
- streaming success is recorded on the terminal `finish` part, and stream errors are recorded once.

Language-model middleware runs at the provider-attempt level. AI SDK retries happen outside the
middleware, so the default `maxRetries: 2` can produce as many as three observations for one logical
`generateText` or `streamText` call. The monitor defaults require six consecutive availability
failures before immediately declaring `down`, but applications should tune thresholds for their retry
policy. Set the AI operation's `maxRetries: 0` when a strict one-observation-per-logical-call model is
required. This package does not add another retry layer.

Custom classification is available through `classifyError` when a provider has different semantics.
The middleware records latency, model ID, status code when available, and a bounded classification;
it never reads or stores prompts, responses, tool arguments, or credentials.

## Testing

Use the testing entry point to avoid network calls and background polling:

```ts
import { Test } from "@nestjs/testing";
import { ProviderStatusService } from "@nestm/provider-status";
import {
	ProviderStatusTestingModule,
	createMemoryProviderStatusProvider,
} from "@nestm/provider-status/testing";

const provider = createMemoryProviderStatusProvider({
	id: "openai",
	name: "OpenAI test provider",
});

const moduleRef = await Test.createTestingModule({
	imports: [ProviderStatusTestingModule.forRoot({ providers: [provider] })],
}).compile();

const status = moduleRef.get(ProviderStatusService);
await status.refresh("openai");

provider.setReport({ status: "degraded", description: "Synthetic degradation." });
await status.refresh("openai");
```

`MemoryProviderStatusProvider` also exposes `setFailure()` and a `checks` counter. Tests and CI
should use fixtures and memory providers rather than live vendor status pages.

## Multi-replica deployments

The monitor is intentionally in-memory and process-local. In a multi-replica deployment:

- each replica polls independently and keeps its own observation window;
- default jitter reduces synchronized polling but does not coordinate replicas;
- local AI call evidence and warnings can differ between replicas;
- an SSE client sees only the replica holding its connection; and
- restarts discard observations and retained public reports.

For a small replica count, independent polling is often acceptable. At larger scale, designate a
monitoring replica, use `polling: false` on other workloads, or supply a custom provider backed by a
central collector. Persist or aggregate snapshots outside this package when dashboards require a
cluster-wide view. Do not use this in-memory monitor as a distributed circuit breaker.

## Security and privacy

- Treat all status pages, custom sources, provider names, incident text, and URLs as untrusted input.
- Configure source URLs in trusted application infrastructure. If tenant or request data can affect
  a URL, enforce a strict allowlist and egress policy to prevent SSRF.
- Bound and sanitize custom-source output before returning it. Never include raw response bodies,
  headers, credentials, internal URLs, prompts, responses, or tenant data.
- The package creates bounded, non-native check error messages, but custom report fields still belong
  to the application and may be exposed by HTTP and SSE.
- AI observations can expose model IDs, status codes, latency, and failure classification. Decide
  whether those fields are appropriate for every dashboard audience.
- Protect dashboard routes and consider whether publishing dependency and incident details assists
  attackers or leaks internal topology.
- `operational` is not a guarantee that a request will succeed. A status source can be stale,
  incomplete, compromised, or unrelated to the exact account, region, model, or API used.
- Keep provider degradation separate from host liveness/readiness by default. Explicit readiness
  coupling can turn a third-party incident into a cascading application outage.
- Review retries and fallback independently. They can duplicate tool side effects, move data to a
  different processor or region, alter model behavior, and increase spend.

See [SECURITY.md](./SECURITY.md) for the reporting process and complete security boundary.

## License

BSD-3-Clause
