import { Injectable } from "@nestjs/common";
import { wrapLanguageModel } from "ai";
import { ProviderStatusService } from "../provider-status.service.ts";
import {
	createProviderStatusMiddleware,
	monitorLanguageModel,
} from "./provider-status-ai-sdk.middleware.ts";
import type {
	MonitorableLanguageModel,
	MonitoredLanguageModel,
	ProviderStatusAiSdkMiddlewareOptions,
} from "./provider-status-ai-sdk.types.ts";

@Injectable()
export class ProviderStatusAiSdkService {
	constructor(readonly status: ProviderStatusService) {}

	middleware(options: ProviderStatusAiSdkMiddlewareOptions = {}) {
		return createProviderStatusMiddleware(this.status, options);
	}

	wrap(
		model: MonitorableLanguageModel,
		options: ProviderStatusAiSdkMiddlewareOptions = {},
	): MonitoredLanguageModel {
		return monitorLanguageModel(model, this.status, options);
	}

	/** Alias convenient for configuration factories that expect the upstream function shape. */
	wrapLanguageModel(
		model: MonitorableLanguageModel,
		options: ProviderStatusAiSdkMiddlewareOptions = {},
	): ReturnType<typeof wrapLanguageModel> {
		return this.wrap(model, options);
	}
}
