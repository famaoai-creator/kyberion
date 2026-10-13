# Concierge startup modes

## Local operator

Build the workspace packages and Concierge using the normal build workflow, then run:

```sh
pnpm --dir presence/displays/concierge local:start
# Development, with Next's webpack dev server:
pnpm --dir presence/displays/concierge local:dev
# Optional explicit port:
pnpm --dir presence/displays/concierge local:start --port 3051
```

The governed Concierge surface manifest uses this local adapter on port 3050.
The typed server and peer run directly with Node 24 native TypeScript support.
No custom TypeScript loader or unanalysed JavaScript wrapper is used.
See [the analysis boundary note](../../../docs/developer/CONCIERGE_LOCAL_PEER_ANALYSIS.md).
Open http://127.0.0.1:3050 or http://localhost:3050 directly in the browser.

The listener always binds 127.0.0.1. It checks the actual socket, requires a
loopback Host with the listener's port, and rejects requests carrying original
proxy or tunnel provenance headers. A random request-lifetime ticket connects
that observation to Next 16's socket-free NextRequest. The ticket stays within
the server request, expires after 30 seconds or response completion, and grants
nothing on an ordinary Next server. Middleware runs in Node to share the
in-process registry with route handlers.

Never expose this local-operator listener through a reverse proxy or tunnel.
A local proxy that removes all provenance is indistinguishable from a local
process. Local processes and other users of the same machine are inside this
local-operator trust boundary.

## Authenticated remote deployment

The existing `dev` and `start` commands remain ordinary Next commands.
Configure server-side tenant scope and supported viewer credentials for remote
access. Forwarded IP headers, including with `KYBERION_TRUST_PROXY` enabled, never
grant Concierge local-operator authority. Proxy IP handling remains available
for rate-limit attribution. Operator-only service registration requires the
explicit local startup above.

## Regression checks

```sh
pnpm --dir presence/displays/concierge exec vitest run test/local-server.test.ts src/middleware.test.ts src/lib/viewer-context.test.ts test/headless-contract.test.ts
```

After changes to Next or the adapter, also build Concierge and verify real HTTP
navigation and a guarded API through the local startup without supplied IP
headers. Check that an ordinary Next startup rejects forged proof and forwarded
loopback headers. Unit fixtures alone do not establish that the custom server,
middleware, and bundled route handlers share the process registry.

## Settings save feedback checks

Run the focused state and accessibility checks before changing grouped or section saves:

```sh
pnpm --dir presence/displays/concierge exec vitest run test/settings-drafts-ui.test.ts test/settings-save-feedback.test.ts
```

Then inspect the actual Settings page component in a browser with isolated synthetic
responses. Scroll to the initiating profile, service-selection, or notification
save control and check pending, confirmed, and unconfirmed results without moving
the viewport. A submitted request with a missing or invalid receipt is unconfirmed;
it must not be described as definitely unwritten or retried automatically.

Edit again while a response is pending: the submitted snapshot may be confirmed
while newer edits remain unsaved. Check repeated clicks, discard, a subsequent
grouped save, failed post-save reads, and identity invalidation. Feedback belongs
to the initiating control; announce it through one live region. Repeat in English
and Japanese and at a narrow viewport. Synthetic response coverage does not prove
backend write behavior; separately verify healthy navigation in the built app.
