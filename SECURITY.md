# Security policy

## Supported versions

`@nestm/provider-status` is prerelease software. Security fixes are provided on
the latest published alpha only.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories
for
[`nestm-dev/provider-status`](https://github.com/nestm-dev/provider-status/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include affected versions, a minimal reproduction, impact, and any suggested
mitigation. Maintainers will coordinate disclosure after a fix is available.

## Security boundary

This package observes provider-published or application-supplied availability
signals and exposes normalized snapshots. It does not authenticate users,
authorize dashboard access, verify a provider's internal systems, guarantee
request success, manage provider credentials, or choose a safe failover model.

Applications remain responsible for:

- configuring only trusted status endpoints and custom source implementations;
- keeping status endpoint configuration server-side and preventing untrusted
  request values from becoming fetch URLs, headers, or provider identifiers;
- protecting dashboard, JSON, metrics, and streaming endpoints with appropriate
  authentication, authorization, CORS, caching, and rate limits;
- deciding whether provider status may affect readiness, request admission,
  routing, retries, fallback, or spend;
- validating actual provider-call failures independently of advisory status
  data; and
- keeping provider credentials, internal topology, tenant identifiers, and
  request content out of status metadata and public warnings.

## External status data

Status pages and custom sources are untrusted external inputs. They can be
stale, unavailable, compromised, incomplete, or inconsistent with the exact
API, region, account, or model used by an application. An `operational`
snapshot is not a security or availability guarantee. A failed status check
must not be normalized as a provider outage.

Implementations must bound response size, request duration, redirects, parsed
component and incident counts, strings, and retained history. Do not include raw
upstream response bodies, headers, native errors, or credential-bearing URLs in
logs, traces, dashboard payloads, exception messages, or observable values.

Generic Statuspage-compatible sources should accept application-owned endpoint
configuration only. If an application derives those endpoints from tenant or
request input, it must enforce a strict allowlist and network egress policy to
prevent server-side request forgery.

## Dashboard and AI SDK integrations

Provider and component names, incident text, and URLs can reveal application
dependencies or be used for content injection. Dashboard clients must render
all text as untrusted content and validate outbound links. Public HTTP
projections should expose normalized, bounded fields and use explicit cache
policy rather than forwarding upstream responses.

AI SDK warnings are advisory. Automatic retries or fallback can duplicate tool
effects, change model behavior, move data to a different processor or region,
and increase spend. The package must not enable rejection, retries, or fallback
without an explicit application policy.

Provider degradation should not fail the host application's liveness or
readiness by default. Opting into readiness coupling can amplify a third-party
incident into a cascading outage and must be reviewed operationally.
