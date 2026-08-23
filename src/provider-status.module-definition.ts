import { ConfigurableModuleBuilder } from "@nestjs/common";
import { PROVIDER_STATUS_MODULE_OPTIONS } from "./provider-status.tokens.ts";
import type {
	ProviderStatusModuleExtras,
	ProviderStatusModuleOptions,
} from "./provider-status.types.ts";

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
	new ConfigurableModuleBuilder<ProviderStatusModuleOptions>({
		optionsInjectionToken: PROVIDER_STATUS_MODULE_OPTIONS,
		alwaysTransient: true,
	})
		.setClassMethodName("forRoot")
		.setFactoryMethodName("createProviderStatusOptions")
		.setExtras<ProviderStatusModuleExtras>({ isGlobal: true }, (definition, extras) => ({
			...definition,
			global: extras.isGlobal !== false,
		}))
		.build();

export type ProviderStatusForRootOptions = typeof OPTIONS_TYPE;
export type ProviderStatusForRootAsyncOptions = typeof ASYNC_OPTIONS_TYPE;
