import { Module, type DynamicModule } from "@nestjs/common";
import { ProviderStatusAiSdkService } from "./provider-status-ai-sdk.service.ts";
import type { ProviderStatusAiSdkModuleRegistrationOptions } from "./provider-status-ai-sdk-module.types.ts";

@Module({
	providers: [ProviderStatusAiSdkService],
	exports: [ProviderStatusAiSdkService],
})
export class ProviderStatusAiSdkModule {
	/** Attach the AI SDK service to a module that exports a non-global status service. */
	static register(options: ProviderStatusAiSdkModuleRegistrationOptions): DynamicModule {
		return { module: ProviderStatusAiSdkModule, imports: [...options.imports] };
	}
}
