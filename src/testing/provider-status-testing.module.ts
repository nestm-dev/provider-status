import { Module, type DynamicModule } from "@nestjs/common";
import type { ProviderStatusMonitorOptions, ProviderStatusProvider } from "../core/index.ts";
import { ProviderStatusModule } from "../provider-status.module.ts";

export interface ProviderStatusTestingModuleOptions {
	readonly providers?: readonly ProviderStatusProvider[];
	readonly observations?: ProviderStatusMonitorOptions["observations"];
	readonly warnings?: ProviderStatusMonitorOptions["warnings"];
}

@Module({})
export class ProviderStatusTestingModule {
	static forRoot(options: ProviderStatusTestingModuleOptions = {}): DynamicModule {
		return {
			module: ProviderStatusTestingModule,
			imports: [
				ProviderStatusModule.forRoot({
					providers: options.providers ?? [],
					polling: false,
					isGlobal: false,
					...(options.observations === undefined ? {} : { observations: options.observations }),
					...(options.warnings === undefined ? {} : { warnings: options.warnings }),
				}),
			],
			exports: [ProviderStatusModule],
		};
	}
}
