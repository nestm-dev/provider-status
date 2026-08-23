import { describe, expect, it, vi } from "vitest";
import { ProviderStatusMonitor, type ProviderStatusProvider } from "../../src/core/index.ts";
import {
	createStatuspageProvider,
	mapStatuspageComponentStatus,
	statuspageDocumentToReport,
	type StatuspageProviderOptions,
	type StatuspageSummaryDocument,
} from "../../src/statuspage/index.ts";

const CHECKED_AT = "2026-08-23T12:00:00.000Z";

type SummaryStatuspageProviderOptions = Extract<
	StatuspageProviderOptions,
	{ readonly summaryUrl: string }
>;

function reportOptions(
	overrides: Partial<SummaryStatuspageProviderOptions> = {},
): SummaryStatuspageProviderOptions {
	return {
		id: "custom",
		name: "Custom AI",
		statusPageUrl: "https://status.custom.test",
		summaryUrl: "https://status.custom.test/api/v2/summary.json",
		...overrides,
	};
}

async function checkProvider(provider: ProviderStatusProvider) {
	if (provider.check === undefined) throw new Error("Expected a checkable provider.");
	return provider.check({ signal: new AbortController().signal, checkedAt: CHECKED_AT });
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("generic Statuspage provider", () => {
	it.each([
		["operational", "operational"],
		["degraded_performance", "degraded"],
		["partial_outage", "degraded"],
		["major_outage", "down"],
		["under_maintenance", "maintenance"],
		["new_status", "unknown"],
		[undefined, "unknown"],
	] as const)("maps component status %s to %s", (input, expected) => {
		expect(mapStatuspageComponentStatus(input)).toBe(expected);
	});

	it("selects configured components, excludes groups, and uses their worst status", () => {
		const globalMatcher = /embeddings/gi;
		globalMatcher.lastIndex = 4;
		const document: StatuspageSummaryDocument = {
			page: { updated_at: "2026-08-23T11:59:00.000Z" },
			status: { indicator: "none", description: "All systems operational" },
			components: [
				{ id: "group", name: "API products", status: "major_outage", group: true },
				{ id: "responses", name: "Responses", status: "operational" },
				{ id: "embeddings", name: "Embeddings", status: "degraded_performance" },
				{ id: "audio", name: "Audio", status: "major_outage", description: "No audio" },
			],
		};

		const report = statuspageDocumentToReport(document, {
			provider: reportOptions(),
			components: ["responses", globalMatcher, (component) => component.name === "Audio"],
		});

		expect(report).toEqual({
			status: "down",
			description: "All systems operational",
			statusPageUrl: "https://status.custom.test",
			upstreamUpdatedAt: "2026-08-23T11:59:00.000Z",
			components: [
				{ id: "responses", name: "Responses", status: "operational" },
				{ id: "embeddings", name: "Embeddings", status: "degraded" },
				{ id: "audio", name: "Audio", status: "down", description: "No audio" },
			],
			incidents: [],
		});
		expect(globalMatcher.lastIndex).toBe(0);
	});

	it("normalizes unresolved incidents, scopes affected components, and applies the limit", () => {
		const report = statuspageDocumentToReport(
			{
				status: { indicator: "major", description: "Major outage" },
				components: [
					{ id: "api", name: "API", status: "partial_outage" },
					{ id: "web", name: "Web", status: "operational" },
				],
				incidents: [
					{
						id: "active-api",
						name: "API errors",
						status: "investigating",
						impact: "major",
						updated_at: "2026-08-23T11:58:00.000Z",
						shortlink: "https://stspg.io/api",
						components: [{ id: "api", name: "API" }],
					},
					{
						id: "resolved-api",
						name: "Old incident",
						status: "resolved",
						components: [{ id: "api", name: "API" }],
					},
					{
						id: "web-only",
						name: "Website issue",
						status: "identified",
						components: [{ id: "web", name: "Web" }],
					},
					{ status: "monitoring" },
				],
			},
			{ provider: reportOptions(), components: ["api"], maxIncidents: 2 },
		);

		expect(report.status).toBe("degraded");
		expect(report.description).toBe("API errors");
		expect(report.incidents).toEqual([
			{
				id: "active-api",
				name: "API errors",
				status: "investigating",
				impact: "major",
				updatedAt: "2026-08-23T11:58:00.000Z",
				url: "https://stspg.io/api",
				components: ["API"],
			},
		]);
	});

	it("does not hide an unknown selected component behind an operational component", () => {
		const report = statuspageDocumentToReport(
			{
				components: [
					{ id: "known", name: "Known API", status: "operational" },
					{ id: "new", name: "New API", status: "new_upstream_state" },
				],
			},
			{ provider: reportOptions() },
		);

		expect(report.status).toBe("unknown");
	});

	it.each([
		["none", "operational"],
		["minor", "degraded"],
		["major", "down"],
		["critical", "down"],
		["maintenance", "maintenance"],
		["unexpected", "unknown"],
		[undefined, "unknown"],
	] as const)("falls back from empty components to page indicator %s", (indicator, expected) => {
		const report = statuspageDocumentToReport(
			{ status: indicator === undefined ? {} : { indicator }, components: [] },
			{ provider: reportOptions() },
		);
		expect(report.status).toBe(expected);
	});

	it("fails closed when configured selectors match nothing unless explicitly allowed", () => {
		const document: StatuspageSummaryDocument = {
			status: { indicator: "minor" },
			components: [{ id: "web", name: "Website", status: "operational" }],
		};

		expect(() =>
			statuspageDocumentToReport(document, {
				provider: reportOptions(),
				components: [/API/i],
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_REPORT", providerId: "custom" }));
		expect(
			statuspageDocumentToReport(document, {
				provider: reportOptions(),
				components: [/API/i],
				requireComponents: false,
			}).status,
		).toBe("degraded");
	});

	it("fetches and converts a summary document with headers and request cancellation", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				status: { indicator: "none", description: "Operational" },
				components: [{ id: "api", name: "API", status: "operational" }],
			}),
		);
		const provider = createStatuspageProvider({
			...reportOptions(),
			components: ["API"],
			headers: { authorization: "Bearer test" },
			fetch: fetchImplementation,
		});
		const controller = new AbortController();

		const report = await provider.check?.({ signal: controller.signal, checkedAt: CHECKED_AT });

		expect(report?.status).toBe("operational");
		expect(fetchImplementation).toHaveBeenCalledWith(
			"https://status.custom.test/api/v2/summary.json",
			{
				method: "GET",
				headers: { accept: "application/json", authorization: "Bearer test" },
				cache: "no-store",
				signal: controller.signal,
			},
		);
	});

	it("combines split status, component, and incident endpoints", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith("status.json")) {
				return jsonResponse({
					page: { updated_at: "2026-08-23T11:55:00.000Z" },
					status: { indicator: "minor", description: "Minor issue" },
				});
			}
			if (url.endsWith("components.json")) {
				return jsonResponse({
					components: [{ id: "api", name: "API", status: "degraded_performance" }],
				});
			}
			return jsonResponse({
				incidents: [
					{
						id: "incident",
						name: "Elevated latency",
						status: "monitoring",
						components: [{ id: "api", name: "API" }],
					},
				],
			});
		});
		const options: StatuspageProviderOptions = {
			id: "split",
			name: "Split",
			statusPageUrl: "https://status.split.test",
			statusUrl: "https://status.split.test/status.json",
			componentsUrl: "https://status.split.test/components.json",
			incidentsUrl: "https://status.split.test/incidents.json",
			components: ["API"],
			fetch: fetchImplementation,
		};

		const report = await checkProvider(createStatuspageProvider(options));

		expect(fetchImplementation).toHaveBeenCalledTimes(3);
		expect(report).toMatchObject({
			status: "degraded",
			description: "Elevated latency",
			upstreamUpdatedAt: "2026-08-23T11:55:00.000Z",
			incidents: [{ id: "incident" }],
		});
	});

	it("rejects HTTP failures and non-object response documents", async () => {
		const httpFailure = createStatuspageProvider({
			...reportOptions(),
			fetch: vi.fn<typeof fetch>(async () => jsonResponse({ error: true }, 503)),
		});
		await expect(checkProvider(httpFailure)).rejects.toThrow(/HTTP 503/);

		const invalidJsonShape = createStatuspageProvider({
			...reportOptions(),
			fetch: vi.fn<typeof fetch>(async () => jsonResponse(["not", "an", "object"])),
		});
		await expect(checkProvider(invalidJsonShape)).rejects.toThrow(/non-object document/);
	});

	it("rejects oversized bodies and exposes them as monitor check failures", async () => {
		const fetchImplementation = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				status: { indicator: "none", description: "x".repeat(256) },
				components: [],
			}),
		);
		const provider = createStatuspageProvider({
			...reportOptions(),
			maxResponseBytes: 64,
			fetch: fetchImplementation,
		});

		await expect(checkProvider(provider)).rejects.toThrow(/configured size limit/);

		const monitor = new ProviderStatusMonitor({ providers: [provider], polling: false });
		await monitor.refresh("custom");
		expect(monitor.get("custom")).toMatchObject({
			sourceState: "unavailable",
			lastCheckError: { code: "CHECK_FAILED" },
		});
		expect(fetchImplementation).toHaveBeenCalledTimes(2);
	});

	it("fails construction when no fetch implementation is available", () => {
		vi.stubGlobal("fetch", undefined);

		expect(() => createStatuspageProvider(reportOptions())).toThrowError(
			expect.objectContaining({
				code: "INVALID_OPTIONS",
				providerId: "custom",
			}),
		);
	});

	it("validates the response-size limit during construction", () => {
		expect(() =>
			createStatuspageProvider({ ...reportOptions(), maxResponseBytes: 0 }),
		).toThrowError(expect.objectContaining({ code: "INVALID_OPTIONS", providerId: "custom" }));
	});
});
