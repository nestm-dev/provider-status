import type { ModuleMetadata } from "@nestjs/common";

export interface ProviderStatusHttpModuleRegistrationOptions {
	/** Modules that export the locally scoped ProviderStatusService. */
	readonly imports: NonNullable<ModuleMetadata["imports"]>;
}
