import type { ProviderStatusMonitorOptions } from "./core/index.ts";

export type ProviderStatusModuleOptions = ProviderStatusMonitorOptions;

export interface ProviderStatusModuleExtras {
	/** Make the module's exported providers globally injectable. Defaults to true. */
	readonly isGlobal?: boolean;
}

export interface ProviderStatusOptionsFactory {
	createProviderStatusOptions(): ProviderStatusModuleOptions | Promise<ProviderStatusModuleOptions>;
}

/** Identity helper that retains literal provider ids in application configuration. */
export function defineProviderStatusConfig<const OPTIONS extends ProviderStatusModuleOptions>(
	options: OPTIONS,
): OPTIONS {
	return options;
}
