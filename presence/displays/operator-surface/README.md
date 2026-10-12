# Operator Web Surface

The Operator Web surface shows mission state, audit history, health, surface guidance,
knowledge, inbox entries, and reasoning settings. CLI remains available for broader
mission operations. This app now has narrowly scoped, governed selection mutations;
it is no longer an entirely read-only application.

## Selection pages and exact write boundary

- /missions/:id: inspect each team role's requested and effective agent identity,
  provider, model, source and reason, with a separate current-eligibility warning if the
  stored target becomes unavailable. Authenticated administrators can preview and save
  auto/preferred/fixed selections. Agent identity is separate from provider and model.
- /reasoning: inspect and edit each role's runtime selection, independent of mission
  actors. An omitted model remains automatic; fixed applies only to requested dimensions.
- Existing inbox acceptance/read-status mutations retain their existing guard.

GET /api/missions/:id/selection and GET /api/reasoning/selection return secret-free
cached projections. POST to these exact paths accepts only action, role, selection and
expectedRevision, plus expectedPreviewToken for mission saves. Preview is read-only: no settings writes, provider discovery, model
calls or runtime launches. Save delegates to the core mission-lifecycle or reasoning
selection facade, which owns validation, locking, revision checks, persistence and audit.
Only authorized reasoning saves enter the dedicated reasoning_settings_writer context,
bounded to the selection file, previous backup and history. Preview never enters that role.
No browser request can choose a filesystem path, destination URL or authorization scope.
Mission saves also require the explicit preview decision token; the facade recomputes the
choice under its lock and rejects a changed target. This token is not authorization.

Selection POST requests require all of:

1. A server-resolved authenticated localadmin principal. Anonymous/loopback viewers
   remain read-only, even on localhost. The app does not manufacture credentials.
2. Same-origin Origin on every request, including bearer-authenticated calls; cross-site
   requests are rejected. Authentication comes from the existing session/credential seam.
3. Server-derived target scope. Mission tier, tenant, organization and project are checked
   against the real mission before mission_controller is entered; the facade rechecks the
   expected mission scope and content revision under its mutation fence. Explicit and
   persisted server scope further narrow access; no Git or working-directory inference
   is used by this guard. Missing scoped
   dimensions and conflicting mission bindings fail closed.
4. Global scope in all dimensions for the global reasoning store. Tenant-, organization-,
   project- or tier-scoped administrators cannot write global runtime settings. Any explicit
   or persisted server tenant/organization/project/mission/task/tier binding also denies
   global settings writes; invalid scope fails closed.
5. A matching revision. Stale updates return HTTP 409; the UI requires reload and a new
   preview. Active mission ownership and unavailable fixed targets remain governed errors.

The browser requires preview before save, blocks repeated in-flight writes, clears stale
previews after edits, and ignores late responses after cancel/navigation. Cancel aborts a
preview; it is disabled while a save may already have committed. Back/Forward and restored
pages refresh their snapshot. Read-only viewers receive no editing controls.

## Local development and browser QA

Run from this directory with existing workspace dependencies:

    pnpm next dev -H 127.0.0.1 -p 3331

Use the existing sign-in workflow for a real authorized administrator. Do not add fake
credentials or edit live settings to test the UI. Loopback alone grants only read access.

A separate, synthetic browser app lives under test/browser. It renders the real selection
component with in-memory fixtures and never imports production auth, API or settings stores:

    pnpm exec next dev test/browser --hostname 127.0.0.1 --port 3342 --webpack

Open http://127.0.0.1:3342. The fixture supplies agent/runtime pages, readonly mode, delayed
responses, request/write counters and a simulated concurrent revision change. Check keyboard
labels, preview zero writes, rapid repeated save, cancel during preview, stale-revision reload,
Back/Forward and light/dark layouts. These are synthetic UI tests, not production access tests.
The independent API unit tests verify real guard composition using isolated mocks.

## Tests and deployment limits

    pnpm test
    pnpm test:no-write-api

The historical no-write-api command now enforces no direct filesystem writes and exactly
three governed POST route files (inbox plus the two selection endpoints). The SSRF guard
continues to forbid server outbound network primitives. Its sole fetch exception is the
client-only transport using fixed same-origin selection paths, with redirects refused.

All other operational pages stay read-only apart from the existing read-audit chokepoint.
Mission lifecycle transitions, pipeline execution, security settings, credentials, registry
editing and deployment remain outside these selection APIs. No arbitrary file-write or
provider-execution endpoint is introduced.

Bind to loopback for development. External exposure still requires the deployment's trusted
authentication/perimeter configuration and independent security review. The UI does not
configure a WAF, install identity providers or expand existing role-assumption permissions.
Existing non-selection data loaders continue to use their documented server tenant filters;
this change does not claim to redesign every legacy page's authorization model.

Opt-in deeper verification from the repository root (after core build):

    node --import ./scripts/ts-loader.mjs presence/displays/operator-surface/test/selection-runtime-smoke.ts
    node --import ./scripts/ts-loader.mjs presence/displays/operator-surface/test/selection-browser-smoke.ts

The runtime smoke copies only public product policy/schema catalogs and synthetic data into
an isolated root, then checks actual facade persistence and role assumptions under
SYSTEM_ROLE=operator_surface. The browser smoke needs the separate fixture server and an
already installed stable Google Chrome. It uses Playwright channel chrome with
chromiumSandbox:true, logs the actual browser version, and fails rather than falling back
to a custom executable or launch flags. It never downloads a browser or disables its sandbox.

The package includes one explicitly GitHub-hosted browser test. Local runs (including
CI=true) list it as skipped and do not establish browser validation. The existing hosted
full-check lane requires both CI=true and GITHUB_ACTIONS=true and uses stable Chrome
already supplied by the Ubuntu runner image. The test starts its isolated fixture,
exercises real browser flows, and fails on missing/failed browser launch. A hosted browser pass
is required before claiming these flows verified. Its 120-second budget covers bounded
startup 45s, scenarios 65s and cleanup 5s; no exception converts a browser failure to success.
