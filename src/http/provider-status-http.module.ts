import { Module, type DynamicModule } from "@nestjs/common";
import { ProviderStatusHttpController } from "./provider-status-http.controller.ts";
import type { ProviderStatusHttpModuleRegistrationOptions } from "./provider-status-http.types.ts";

/**
 * Optional dashboard transport. Import it only where the configured
 * `ProviderStatusService` is visible (global by default), and protect the
 * routes with the application's own authentication/authorization policy.
 */
@Module({ controllers: [ProviderStatusHttpController] })
export class ProviderStatusHttpModule {
	/** Attach the dashboard controller to a module that exports a non-global status service. */
	static register(options: ProviderStatusHttpModuleRegistrationOptions): DynamicModule {
		return { module: ProviderStatusHttpModule, imports: [...options.imports] };
	}
}
