import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { ProviderStatusMonitor } from "./core/index.ts";
import { PROVIDER_STATUS_MODULE_OPTIONS } from "./provider-status.tokens.ts";
import type { ProviderStatusModuleOptions } from "./provider-status.types.ts";

@Injectable()
export class ProviderStatusService
	extends ProviderStatusMonitor
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	constructor(@Inject(PROVIDER_STATUS_MODULE_OPTIONS) options: ProviderStatusModuleOptions) {
		super(options);
	}

	onApplicationBootstrap(): void {
		if (this.polling !== false && this.polling.startOnBootstrap) this.start();
	}

	onApplicationShutdown(): void {
		this.stop();
	}
}
