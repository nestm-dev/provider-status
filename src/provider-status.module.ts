import { Module, type DynamicModule } from "@nestjs/common";
import {
	ConfigurableModuleClass,
	type ProviderStatusForRootAsyncOptions,
	type ProviderStatusForRootOptions,
} from "./provider-status.module-definition.ts";
import { ProviderStatusService } from "./provider-status.service.ts";
import { PROVIDER_STATUS_MODULE_OPTIONS } from "./provider-status.tokens.ts";

@Module({
	providers: [ProviderStatusService],
	exports: [PROVIDER_STATUS_MODULE_OPTIONS, ProviderStatusService],
})
export class ProviderStatusModule extends ConfigurableModuleClass {
	static forRoot(options: ProviderStatusForRootOptions): DynamicModule {
		return super.forRoot(options);
	}

	static forRootAsync(options: ProviderStatusForRootAsyncOptions): DynamicModule {
		return super.forRootAsync(options);
	}
}
