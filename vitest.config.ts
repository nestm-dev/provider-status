import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts", "scripts/**/*.spec.mjs"],
		setupFiles: ["tests/setup.ts"],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		pool: "forks",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/index.ts"],
		},
	},
});
