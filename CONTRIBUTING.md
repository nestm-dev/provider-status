# Contributing

## Setup

```sh
corepack enable
pnpm install
```

Node.js 22.12 or newer is required. The package is ESM-only and targets the
NestJS 12 prerelease line. AI SDK 7 is optional and belongs only to the
`@nestm/provider-status/ai-sdk` entry point.

## Workflow

```sh
pnpm run check        # Oxlint, Prettier, and TypeScript
pnpm run test         # unit, Express/Fastify E2E, and compile-time tests
pnpm run build        # ESM and declaration output in dist/
pnpm run verify:pack  # build and validate the packed public package
pnpm run verify       # all local release gates
```

Add a Changeset for every user-visible change with `pnpm changeset`.

## Design rules

- Keep `src/core` framework-neutral. It must have no NestJS, AI SDK, or HTTP
  adapter imports in runtime code or emitted declarations.
- Keep every optional entry point independently importable and side-effect
  free. Root imports must never load `ai`, Express, Fastify, or a concrete
  provider SDK.
- Treat external status documents as untrusted input. Validate and bound them
  before producing a public snapshot.
- Distinguish an upstream outage from a failed status check. A timeout, invalid
  response, or unreachable status page becomes `unknown` or stale; it does not
  prove that the monitored provider is unavailable.
- Poll centrally on a bounded schedule. Do not fetch a provider status page for
  each application or AI request, and do not allow overlapping checks for one
  source.
- Preserve the last trustworthy observation when a later check fails, mark its
  freshness explicitly, and keep timestamps deterministic and injectable in
  tests.
- Expose immutable snapshots and read-only observables. Do not expose an RxJS
  subject or another public mutation channel.
- Make readiness failure and AI-call rejection explicit opt-ins. Dashboard
  warnings must not create a cascading outage by default.
- Keep provider clients, credentials, endpoint policy, custom sources, and
  routing/fallback policy application-owned.
- Keep `./http` adapter-neutral and verify the same behavior with Express and
  Fastify. Neither platform package belongs in peer dependencies.
- Preserve ESM output, explicit package exports, source maps, declarations, and
  emitted Nest decorator metadata.

## Tests

- Use deterministic clocks and fake sources; ordinary tests and CI must never
  call a live vendor status page or AI model.
- Cover source timeout/cancellation, stale transitions, severity aggregation,
  duplicate IDs, scheduler teardown, and non-overlapping polls.
- Exercise `forRoot()` and every `forRootAsync()` strategy through
  `@nestjs/testing`.
- Add compile-time tests for custom source definitions, provider IDs, optional
  AI mappings, and public observable types.
- Test every exported subpath from the packed package and verify that root,
  core, statuspage, and HTTP imports work without `ai` installed.
- Run HTTP E2E scenarios against both Express and Fastify.

## Documentation

Document public behavior in `README.md`, including status semantics, freshness,
polling, custom sources, optional entry-point installation, and complete NestJS
examples. Keep documented compatibility and exports synchronized with
`package.json`.

## Pull requests

Keep changes focused, include regression coverage, and run `pnpm run verify`
before requesting review. Call out changes to severity mapping, source trust,
freshness, readiness policy, public projections, or optional dependency
boundaries explicitly.
