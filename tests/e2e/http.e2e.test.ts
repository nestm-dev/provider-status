import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderStatusModule, ProviderStatusService } from "../../src/index.ts";
import { ProviderStatusHttpModule } from "../../src/http/index.ts";
import { createMemoryProviderStatusProvider } from "../../src/testing/index.ts";

const testHttpAdapter = process.env.TEST_HTTP_ADAPTER ?? "express";
const provider = createMemoryProviderStatusProvider({ id: "openai", name: "OpenAI API" });

@Module({
	imports: [
		ProviderStatusHttpModule.register({
			imports: [
				ProviderStatusModule.forRoot({
					providers: [provider],
					polling: false,
					isGlobal: false,
				}),
			],
		}),
	],
})
class HttpTestModule {}

describe(`provider status HTTP projection (${testHttpAdapter})`, () => {
	let app: INestApplication;
	let baseUrl: string;
	let status: ProviderStatusService;

	beforeAll(async () => {
		const moduleReference = await Test.createTestingModule({ imports: [HttpTestModule] }).compile();
		app = moduleReference.createNestApplication(
			testHttpAdapter === "fastify" ? new FastifyAdapter() : new ExpressAdapter(),
			{ logger: false },
		);
		await app.init();
		if (testHttpAdapter === "fastify") await app.getHttpAdapter().getInstance().ready();
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
		status = app.get(ProviderStatusService);
	});

	beforeEach(async () => {
		provider.setReport({ status: "operational", description: "All systems operational." });
		await status.refresh("openai");
	});

	afterAll(async () => {
		await app.close();
	});

	it("serves a dashboard snapshot and one provider", async () => {
		const snapshot = await request(app.getHttpServer()).get("/provider-status");
		const oneProvider = await request(app.getHttpServer()).get("/provider-status/openai");

		expect(snapshot.status).toBe(200);
		expect(snapshot.headers["cache-control"]).toBe("no-store");
		expect(snapshot.body).toMatchObject({
			status: "operational",
			providers: [{ id: "openai", reportedStatus: "operational" }],
			warnings: [],
		});
		expect(oneProvider.status).toBe(200);
		expect(oneProvider.body).toMatchObject({ id: "openai", name: "OpenAI API" });
	});

	it("projects degraded providers as dashboard warnings", async () => {
		provider.setReport({ status: "degraded", description: "Elevated API errors." });
		await status.refresh("openai");

		const response = await request(app.getHttpServer()).get("/provider-status/warnings");

		expect(response.status).toBe(200);
		expect(response.body).toEqual([
			expect.objectContaining({
				providerId: "openai",
				kind: "degraded",
				severity: "warning",
			}),
		]);
	});

	it("returns 404 for an unknown provider", async () => {
		const response = await request(app.getHttpServer()).get("/provider-status/missing");

		expect(response.status).toBe(404);
	});

	it("emits the current snapshot over SSE", async () => {
		const response = await fetch(`${baseUrl}/provider-status/stream`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("SSE response did not contain a readable body.");

		let payload = "";
		while (!payload.includes("event: provider-status")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			payload += new TextDecoder().decode(chunk.value);
		}
		await reader.cancel();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(payload).toContain("event: provider-status");
		expect(payload).toContain('"id":"openai"');
	});
});
