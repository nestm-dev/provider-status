import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const entryPoints = [".", "./core", "./statuspage", "./ai-sdk", "./http", "./testing"];

for (const entry of [...entryPoints, "./package.json"]) {
	if (packageJson.exports?.[entry] === undefined) {
		throw new Error(`Missing package export: ${entry}`);
	}
}

const artifactPaths = entryPoints.flatMap((entry) => {
	const directory = entry === "." ? "" : `${entry.slice(2)}/`;
	return [`../dist/${directory}index.mjs`, `../dist/${directory}index.d.mts`];
});

for (const file of artifactPaths) {
	if (!existsSync(new URL(file, import.meta.url))) {
		throw new Error(`Missing build artifact: ${file.replace("../", "")}`);
	}
}

if (packageJson.peerDependenciesMeta?.ai?.optional !== true) {
	throw new Error("The AI SDK peer must remain optional");
}

for (const forbiddenPeer of [
	"@nestjs/platform-express",
	"@nestjs/platform-fastify",
	"express",
	"fastify",
]) {
	if (packageJson.peerDependencies?.[forbiddenPeer] !== undefined) {
		throw new Error(`HTTP platform package must not be a peer dependency: ${forbiddenPeer}`);
	}
}

const readArtifact = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const rootSource = readArtifact("../dist/index.mjs");
const coreSource = readArtifact("../dist/core/index.mjs");
const coreTypes = readArtifact("../dist/core/index.d.mts");
const statuspageSource = readArtifact("../dist/statuspage/index.mjs");
const statuspageTypes = readArtifact("../dist/statuspage/index.d.mts");
const httpSource = readArtifact("../dist/http/index.mjs");

for (const [name, source] of [
	["root", rootSource],
	["core", coreSource],
	["core declarations", coreTypes],
	["statuspage", statuspageSource],
	["statuspage declarations", statuspageTypes],
	["http", httpSource],
]) {
	if (/from\s+["']ai(?:\/|["'])/.test(source)) {
		throw new Error(`${name} entry point must not load the optional AI SDK peer`);
	}
}

for (const [name, source] of [
	["core", coreSource],
	["core declarations", coreTypes],
]) {
	if (source.includes("@nestjs/")) {
		throw new Error(`${name} entry point must remain framework-neutral`);
	}
}

for (const platformPackage of [
	"@nestjs/platform-express",
	"@nestjs/platform-fastify",
	"express",
	"fastify",
]) {
	if (httpSource.includes(platformPackage)) {
		throw new Error(`HTTP entry point must remain platform-neutral: ${platformPackage}`);
	}
}

const runtimeSources = artifactPaths
	.filter((path) => path.endsWith(".mjs"))
	.map((path) => readArtifact(path));

if (!runtimeSources.some((source) => source.includes("design:paramtypes"))) {
	throw new Error("Decorator metadata is missing from the build output");
}
