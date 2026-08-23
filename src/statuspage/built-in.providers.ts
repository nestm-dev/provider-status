import type { ProviderStatusProvider } from "../core/index.ts";
import { createStatuspageProvider } from "./statuspage.provider.ts";
import type {
	AnthropicStatusProviderOptions,
	OpenAIStatusProviderOptions,
	StatuspageComponentMatcher,
} from "./statuspage.types.ts";

const OPENAI_API_COMPONENTS: readonly StatuspageComponentMatcher[] = [
	"Responses",
	"Chat Completions",
	"Images",
	"Image Generation",
	"Audio",
	"Files",
	"File uploads",
	"Search",
	"Fine-tuning",
	"Realtime",
	"Batch",
	"Embeddings",
	"Moderations",
];

const ANTHROPIC_API_COMPONENTS: readonly StatuspageComponentMatcher[] = [
	"k8w3r06qmzrp",
	"Claude API (api.anthropic.com)",
];

/** Monitors OpenAI API surfaces used by server-side AI SDK calls, not ChatGPT UI health. */
export function createOpenAIStatusProvider(
	options: OpenAIStatusProviderOptions = {},
): ProviderStatusProvider {
	return createStatuspageProvider({
		id: options.id ?? "openai",
		name: options.name ?? "OpenAI API",
		statusPageUrl: "https://status.openai.com",
		statusUrl: "https://status.openai.com/api/v2/status.json",
		componentsUrl: "https://status.openai.com/api/v2/components.json",
		incidentsUrl: "https://status.openai.com/api/v2/incidents.json",
		components: options.components ?? OPENAI_API_COMPONENTS,
		...(options.maxIncidents === undefined ? {} : { maxIncidents: options.maxIncidents }),
		...(options.maxResponseBytes === undefined
			? {}
			: { maxResponseBytes: options.maxResponseBytes }),
		...(options.includeUnscopedIncidents === undefined
			? {}
			: { includeUnscopedIncidents: options.includeUnscopedIncidents }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
}

/** Monitors the Claude API component, not claude.ai, Claude Code, or Claude Cowork. */
export function createAnthropicStatusProvider(
	options: AnthropicStatusProviderOptions = {},
): ProviderStatusProvider {
	return createStatuspageProvider({
		id: options.id ?? "anthropic",
		name: options.name ?? "Claude API",
		statusPageUrl: "https://status.claude.com",
		summaryUrl: "https://status.claude.com/api/v2/summary.json",
		components: options.components ?? ANTHROPIC_API_COMPONENTS,
		...(options.maxIncidents === undefined ? {} : { maxIncidents: options.maxIncidents }),
		...(options.maxResponseBytes === undefined
			? {}
			: { maxResponseBytes: options.maxResponseBytes }),
		...(options.includeUnscopedIncidents === undefined
			? {}
			: { includeUnscopedIncidents: options.includeUnscopedIncidents }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
}

export { ANTHROPIC_API_COMPONENTS, OPENAI_API_COMPONENTS };
