import type {
	ProviderStatusCheckContext,
	ProviderStatusProvider,
	ProviderStatusReport,
} from "../core/index.ts";

export interface MemoryProviderStatusOptions {
	readonly id?: string;
	readonly name?: string;
	readonly statusPageUrl?: string;
	readonly initial?: ProviderStatusReport;
}

/** Deterministic, network-free provider for unit and integration tests. */
export class MemoryProviderStatusProvider implements ProviderStatusProvider {
	readonly id: string;
	readonly name: string;
	readonly statusPageUrl?: string;
	checks = 0;
	private result: ProviderStatusReport;
	private failure?: unknown;

	constructor(options: MemoryProviderStatusOptions = {}) {
		this.id = options.id ?? "test";
		this.name = options.name ?? "Test provider";
		this.statusPageUrl = options.statusPageUrl;
		this.result = options.initial ?? {
			status: "operational",
			description: "Test provider is operational.",
		};
	}

	setReport(report: ProviderStatusReport): void {
		this.result = report;
		this.failure = undefined;
	}

	setFailure(error: unknown = new Error("Synthetic provider status failure.")): void {
		this.failure = error;
	}

	check(_context: ProviderStatusCheckContext): ProviderStatusReport {
		this.checks += 1;
		if (this.failure !== undefined) throw this.failure;
		return this.result;
	}
}

export function createMemoryProviderStatusProvider(
	options: MemoryProviderStatusOptions = {},
): MemoryProviderStatusProvider {
	return new MemoryProviderStatusProvider(options);
}
