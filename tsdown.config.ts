import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/core/index.ts",
		"src/statuspage/index.ts",
		"src/ai-sdk/index.ts",
		"src/http/index.ts",
		"src/testing/index.ts",
	],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nestjs\//, /^ai(\/|$)/, "reflect-metadata", "rxjs"],
	},
});
