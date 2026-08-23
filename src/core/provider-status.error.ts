import type { ProviderStatus } from "./provider-status.types.ts";

export type ProviderStatusErrorCode =
	| "INVALID_OPTIONS"
	| "DUPLICATE_PROVIDER"
	| "UNKNOWN_PROVIDER"
	| "INVALID_REPORT"
	| "PROVIDER_UNAVAILABLE";

export class ProviderStatusError extends Error {
	readonly code: ProviderStatusErrorCode;
	readonly providerId?: string;
	readonly status?: ProviderStatus;

	constructor(
		code: ProviderStatusErrorCode,
		message: string,
		options: ErrorOptions & { providerId?: string; status?: ProviderStatus } = {},
	) {
		super(message, options);
		this.name = "ProviderStatusError";
		this.code = code;
		this.providerId = options.providerId;
		this.status = options.status;
	}
}
