import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderStatusModule, ProviderStatusService } from "../../src/index.ts";
import { ProviderStatusAiSdkModule, ProviderStatusAiSdkService } from "../../src/ai-sdk/index.ts";
import {
	createMemoryProviderStatusProvider,
	ProviderStatusTestingModule,
} from "../../src/testing/index.ts";

const CONFIGURED_PROVIDER = Symbol("CONFIGURED_PROVIDER");
const asyncProvider = createMemoryProviderStatusProvider({
	id: "async-provider",
	name: "Async provider",
});

@Module({
	providers: [{ provide: CONFIGURED_PROVIDER, useValue: asyncProvider }],
	exports: [CONFIGURED_PROVIDER],
})
class ConfigurationFixtureModule {}

describe("ProviderStatusModule", () => {
	const closeCallbacks: Array<() => Promise<void>> = [];

	afterEach(async () => {
		await Promise.all(closeCallbacks.splice(0).map((close) => close()));
	});

	it("builds a service through synchronous configuration", async () => {
		const provider = createMemoryProviderStatusProvider({ id: "sync-provider" });
		const moduleReference = await Test.createTestingModule({
			imports: [
				ProviderStatusModule.forRoot({
					providers: [provider],
					polling: false,
					isGlobal: false,
				}),
			],
		}).compile();
		closeCallbacks.push(() => moduleReference.close());

		const status = moduleReference.get(ProviderStatusService);
		await status.refresh("sync-provider");

		expect(status.get("sync-provider")).toMatchObject({
			status: "operational",
			sourceState: "available",
		});
	});

	it("supports injected asynchronous configuration", async () => {
		const moduleReference = await Test.createTestingModule({
			imports: [
				ProviderStatusModule.forRootAsync({
					imports: [ConfigurationFixtureModule],
					inject: [CONFIGURED_PROVIDER],
					isGlobal: false,
					useFactory: (provider: typeof asyncProvider) => ({
						providers: [provider],
						polling: false,
					}),
				}),
			],
		}).compile();
		closeCallbacks.push(() => moduleReference.close());

		const status = moduleReference.get(ProviderStatusService);
		await status.refresh("async-provider");

		expect(status.get("async-provider")?.reportedStatus).toBe("operational");
	});

	it("exports the configured service from the testing module", async () => {
		const provider = createMemoryProviderStatusProvider({ id: "test-provider" });
		const moduleReference = await Test.createTestingModule({
			imports: [ProviderStatusTestingModule.forRoot({ providers: [provider] })],
		}).compile();
		closeCallbacks.push(() => moduleReference.close());

		const status = moduleReference.get(ProviderStatusService);
		await status.refresh("test-provider");

		expect(status.get("test-provider")?.sourceState).toBe("available");
		expect(status.polling).toBe(false);
	});

	it("resolves the AI SDK integration with a non-global status module", async () => {
		const provider = createMemoryProviderStatusProvider({ id: "local-ai" });
		const moduleReference = await Test.createTestingModule({
			imports: [
				ProviderStatusAiSdkModule.register({
					imports: [
						ProviderStatusModule.forRoot({
							providers: [provider],
							polling: false,
							isGlobal: false,
						}),
					],
				}),
			],
		}).compile();
		closeCallbacks.push(() => moduleReference.close());

		const integration = moduleReference.get(ProviderStatusAiSdkService);

		expect(integration.status.has("local-ai")).toBe(true);
		expect(integration.middleware({ providerId: "local-ai" })).toMatchObject({
			wrapGenerate: expect.any(Function),
			wrapStream: expect.any(Function),
		});
	});
});
