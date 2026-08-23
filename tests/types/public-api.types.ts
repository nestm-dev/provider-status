import type { DynamicModule } from "@nestjs/common";
import type { LanguageModelMiddleware } from "ai";
import {
	defineProviderStatusConfig,
	ProviderStatusModule,
	ProviderStatusService,
	type ProviderStatusProvider,
} from "../../src/index.ts";
import {
	createProviderStatusMiddleware,
	ProviderStatusAiSdkModule,
	type ProviderStatusAiSdkMiddlewareOptions,
} from "../../src/ai-sdk/index.ts";
import { ProviderStatusMonitor, type ProviderStatusSnapshot } from "../../src/core/index.ts";
import { ProviderStatusHttpModule } from "../../src/http/index.ts";
import { createOpenAIStatusProvider } from "../../src/statuspage/index.ts";
import { createMemoryProviderStatusProvider } from "../../src/testing/index.ts";

const customProvider = {
	id: "internal-ai",
	name: "Internal AI",
	check: () => ({ status: "operational" as const }),
} satisfies ProviderStatusProvider;

const config = defineProviderStatusConfig({
	providers: [createOpenAIStatusProvider(), customProvider],
	polling: { intervalMs: 60_000 },
	isGlobal: false,
});

const syncModule: DynamicModule = ProviderStatusModule.forRoot(config);
const localHttpModule: DynamicModule = ProviderStatusHttpModule.register({ imports: [syncModule] });
const localAiModule: DynamicModule = ProviderStatusAiSdkModule.register({ imports: [syncModule] });
const asyncModule: DynamicModule = ProviderStatusModule.forRootAsync({
	isGlobal: false,
	useFactory: () => ({ providers: [customProvider], polling: false }),
});
const httpModule: typeof ProviderStatusHttpModule = ProviderStatusHttpModule;
const monitor = new ProviderStatusMonitor({ providers: [customProvider], polling: false });
const snapshot: ProviderStatusSnapshot = monitor.getSnapshot();
const middlewareOptions: ProviderStatusAiSdkMiddlewareOptions = { providerId: "internal-ai" };
const middleware: LanguageModelMiddleware = createProviderStatusMiddleware(
	monitor,
	middlewareOptions,
);
const memory = createMemoryProviderStatusProvider();

function acceptService(_service: ProviderStatusService): void {}

void syncModule;
void localHttpModule;
void localAiModule;
void asyncModule;
void httpModule;
void acceptService;
void snapshot;
void middleware;
void memory;
