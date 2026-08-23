import type { DynamicModule } from "@nestjs/common";
import type { LanguageModelMiddleware } from "ai";
import {
	ProviderStatusModule,
	ProviderStatusService,
	type ProviderStatusProvider,
} from "@nestm/provider-status";
import {
	createProviderStatusMiddleware,
	ProviderStatusAiSdkModule,
} from "@nestm/provider-status/ai-sdk";
import { ProviderStatusMonitor, type ProviderStatusSnapshot } from "@nestm/provider-status/core";
import { ProviderStatusHttpModule } from "@nestm/provider-status/http";
import { createAnthropicStatusProvider } from "@nestm/provider-status/statuspage";
import { createMemoryProviderStatusProvider } from "@nestm/provider-status/testing";

const provider = {
	id: "custom",
	name: "Custom provider",
	check: () => ({ status: "operational" as const }),
} satisfies ProviderStatusProvider;

const moduleDefinition: DynamicModule = ProviderStatusModule.forRoot({
	providers: [createAnthropicStatusProvider(), provider],
	polling: false,
});
const localHttp: DynamicModule = ProviderStatusHttpModule.register({
	imports: [moduleDefinition],
});
const localAi: DynamicModule = ProviderStatusAiSdkModule.register({
	imports: [moduleDefinition],
});
const monitor = new ProviderStatusMonitor({ providers: [provider], polling: false });
const snapshot: ProviderStatusSnapshot = monitor.getSnapshot();
const middleware: LanguageModelMiddleware = createProviderStatusMiddleware(monitor, {
	providerId: "custom",
});
const service: typeof ProviderStatusService = ProviderStatusService;
const http: typeof ProviderStatusHttpModule = ProviderStatusHttpModule;
const memory = createMemoryProviderStatusProvider();

void moduleDefinition;
void localHttp;
void localAi;
void snapshot;
void middleware;
void service;
void http;
void memory;
