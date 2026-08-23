import type { ProviderStatusComponent, ProviderStatusProvider } from "../core/index.ts";

export interface StatuspageComponent {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly description?: string | null;
	readonly group?: boolean;
}

export type StatuspageComponentMatcher =
	string | RegExp | ((component: StatuspageComponent) => boolean);

export interface StatuspageProviderCommonOptions {
	readonly id: string;
	readonly name: string;
	readonly statusPageUrl: string;
	/**
	 * Components to monitor. Strings match an exact component id or name.
	 * When omitted, all non-group components contribute to health.
	 */
	readonly components?: readonly StatuspageComponentMatcher[];
	/** Fail the check if configured component selectors match nothing. Defaults to true. */
	readonly requireComponents?: boolean;
	/** Maximum unresolved incidents retained in a report. Defaults to 3. */
	readonly maxIncidents?: number;
	/** Keep incidents without component metadata when filtering components. Defaults to false. */
	readonly includeUnscopedIncidents?: boolean;
	/** Maximum accepted JSON response body per endpoint. Defaults to 1 MB. */
	readonly maxResponseBytes?: number;
	readonly fetch?: typeof globalThis.fetch;
	readonly headers?: Readonly<Record<string, string>>;
}

export type StatuspageProviderOptions = StatuspageProviderCommonOptions &
	(
		| {
				readonly summaryUrl: string;
				readonly statusUrl?: never;
				readonly componentsUrl?: never;
				readonly incidentsUrl?: never;
		  }
		| {
				readonly summaryUrl?: never;
				readonly statusUrl: string;
				readonly componentsUrl: string;
				readonly incidentsUrl: string;
		  }
	);

export interface OpenAIStatusProviderOptions {
	readonly id?: string;
	readonly name?: string;
	readonly components?: readonly StatuspageComponentMatcher[];
	readonly maxIncidents?: number;
	readonly maxResponseBytes?: number;
	readonly includeUnscopedIncidents?: boolean;
	readonly fetch?: typeof globalThis.fetch;
}

export interface AnthropicStatusProviderOptions {
	readonly id?: string;
	readonly name?: string;
	readonly components?: readonly StatuspageComponentMatcher[];
	readonly maxIncidents?: number;
	readonly maxResponseBytes?: number;
	readonly includeUnscopedIncidents?: boolean;
	readonly fetch?: typeof globalThis.fetch;
}

export interface StatuspageSummaryDocument {
	readonly page?: {
		readonly id?: string;
		readonly name?: string;
		readonly url?: string;
		readonly updated_at?: string;
	};
	readonly status?: {
		readonly description?: string;
		readonly indicator?: string;
	};
	readonly components?: readonly StatuspageComponent[];
	readonly incidents?: readonly StatuspageIncident[];
}

export interface StatuspageIncident {
	readonly id?: string;
	readonly name?: string;
	readonly status?: string;
	readonly impact?: string;
	readonly updated_at?: string;
	readonly shortlink?: string;
	readonly components?: ReadonlyArray<{ readonly id?: string; readonly name?: string }>;
}

export interface StatuspageReportOptions {
	readonly provider: Pick<ProviderStatusProvider, "id" | "name" | "statusPageUrl">;
	readonly components?: readonly StatuspageComponentMatcher[];
	readonly requireComponents?: boolean;
	readonly maxIncidents?: number;
	readonly includeUnscopedIncidents?: boolean;
}

export interface NormalizedStatuspageSelection {
	readonly components: readonly ProviderStatusComponent[];
	readonly componentIds: ReadonlySet<string>;
}
