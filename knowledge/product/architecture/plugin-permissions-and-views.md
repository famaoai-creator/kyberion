---
title: Plugin Permissions, Lifecycle and Views
category: Architecture
tags:
  [
    plugins,
    permissions,
    approval,
    digest,
    sandbox,
    lifecycle,
    a2ui,
    views,
    iframe,
    csp,
    plugin-host,
    security,
  ]
importance: 7
last_updated: 2026-09-26
---

# Plugin Permissions, Lifecycle and Views

How Kyberion decides what an installed plugin may do, keeps that decision
bound to the exact code a human approved, applies changes with the least
disruption, and lets a plugin contribute UI without contributing UI code.
Operator-facing summary: [`plugins/README.md`](../../../plugins/README.md).
Plan: `docs/developer/improvement-plans-2026-09/ELIZA_ADOPTION_PLAN_2026-09-24.ja.md` §5 (EP-01〜EP-06) and phase 3 (PH-01〜PH-03).

## 1. Layers

| Layer                     | Module                                                                        | Decides                                                        |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Provenance trust (KD-06)  | `plugin-source-trust.ts`, `skill-plugin-loader.ts`                            | official / curated / third-party from the resolved location    |
| Approval binding (EP-01)  | `plugin-managed-install.ts`                                                   | approval ⇔ content digest + manifest version + grant digest    |
| Permission grant (EP-02)  | `plugin-permissions.ts`, `governance/plugin-permission-policy.json`           | request ∩ trust ceiling ∩ tenant override                      |
| Runtime mediation (EP-03) | `plugin-grant-runtime.ts`, `plugin-contributions.ts`, `sandbox-policy.ts`     | governed host paths check the executing plugin's grant         |
| Lifecycle (EP-04)         | `plugin-lifecycle.ts`, `scripts/plugin_install.ts --reload/--deactivate`      | ownership ledger, activate / reload / deactivate, apply ladder |
| Views (EP-05)             | `plugin-view-contract.ts`, Chronos `GET/POST /api/headless/a2ui/plugin-views` | declarative A2UI documents, viewer gating, action routing      |
| Plugin host (PH-01)       | `plugin-host.ts`, Chronos `lib/plugin-host-boot.ts` + `instrumentation.ts`    | which approved plugins run inside a long-running surface       |
| Iframe views (PH-02)      | `plugin-view-frame.ts`, Chronos `plugin-views/frame` route + frame broker     | sandboxed HTML views, CSP, postMessage action requests         |

Each layer only narrows what the previous one allowed; none of them widens.

## 2. Approval is bound to content (EP-01)

The managed copy's digest is `sha256` over sorted `relative/path\0sha256(file)`
entries (the record file excluded, symlinks rejected). The approval payload
hash covers that digest, the manifest version and the digest of the narrowed
grant. Every read of a managed record re-derives all three; any drift yields
`blocked_digest_mismatch`, and the loader re-checks the digest immediately
before `import()` to keep the TOCTOU window small. Legacy records without a
digest fall back to `pending_approval` and need one reinstall + re-approval.
The approved manifest is the single one at the package root: packages with
several root candidates (`manifest_ambiguous`) or any candidate below the root
(`manifest_nested`) are `blocked_broken_manifest`, and managed-install readers
(skill loader, grant resolution via the record) never walk to another one.

Consequence: _every_ content change — including a `views/`-only change the
apply ladder would classify as `config_apply` — is invisible to runtime until
the new version is reinstalled and approved. Because the install replaces the
managed copy in place, the previous activation is deactivated while the new
version awaits approval (`reloadPlugin` answers "no longer activatable (new
version awaits approval …); previous activation deactivated") — the old module
could otherwise lazily load the unapproved files. Surfaces show the state honestly: the concierge plugin
screen labels it "changed since approval — reinstall required" and refuses
to approve the stale request with HTTP 409.

## 3. Permission grants (EP-02, EP-03)

The manifest `permissions` block (network, fs with tier-relative paths,
`ops_invoke`, `env`, `secrets`) is intersected at install time with the
per-trust ceiling and an optional narrow-only tenant override. Confidential
paths are confined to the installing tenant. A critical capability narrowed
to nothing aborts the install with the elevation that would be required.

At runtime every executable contribution runs inside `runWithPluginGrant`,
which sets the intersection of the enclosing sandbox policy and the grant and
records the executing plugin. Governed paths consult it: secure-io writes,
sandbox/URL network checks, the `plugin-grant-ops` op guard (`ops_invoke`),
`getSecret` (`secrets`) and `getPluginEnv()` (`env`).

## 4. Threat model and limits

In scope — the grant stops a well-behaved plugin, or a plugin misused through
its declared entry points, from:

- writing outside its granted fs scope through secure-io;
- reaching hosts outside its network grant through the sandbox/URL checks;
- invoking ops outside `ops_invoke` through op dispatch;
- resolving secrets or env vars it was not granted;
- providing reserved seams (`core-clock`, `risky-approval-handler`,
  `risky-approval-override`, `scenario-op-override`);
- running after its content changed without a new human approval;
- disposing another plugin's contributions (ownership ledger).

Out of scope — **this is cooperative enforcement, not an isolation
boundary**. In-process plugin code that imports `node:fs`, opens sockets,
reads `process.env` or monkey-patches globals is not stopped, and filesystem
reads are not restricted. Reloads keep the previous module instance in memory
until the process exits. The only real defence against malicious code is the
human approval: approve only plugins you would run with the host's own
privileges.

## 5. Lifecycle and the apply ladder (EP-04)

`applyPluginChange` is a pure classifier over before/after snapshots:
`config_apply` (permissions narrowed, views-only change), `plugin_reload`
(ops / hooks / prompt sections / facets / code changed, permissions widened
or newly applied to a legacy plugin) and `restart_required` (seams or
providers changed, or code of a seam/provider plugin changed). The worst
rung wins. `reloadPlugin` re-resolves the plugin, applies the rung, and on
failure re-activates the previous module (or reports `restart_required` if
that fails too). `reloadPlugin` does not know which files changed, so a
re-approved view edit is applied as `plugin_reload`; callers that do know
the changed paths pass `changedPaths` to `applyPluginChange`.

## 6. Plugin-contributed views (EP-05)

Views are data. A `provides.views` entry declares an id, a vocabulary title
key, a document under `views/`, isolation, capabilities, a role gate, actions
and a refresh mode (schema:
`knowledge/product/schemas/plugin-view-declaration.schema.json`). Declared
view ids are recorded in the ownership ledger as `pluginId:viewId`; nothing
executes.

Validation (`validatePluginView`) is deny-by-default:

- the document is a list of A2UI messages, validated against
  `a2ui-message.schema.json` and the catalog props (`validateA2UIMessage`);
  exactly one `createSurface` with catalog `kyberion-base`; one surface id;
  no `deleteSurface`; unique component ids; children must exist;
- component types come from a display-only subset of `kyberion-base` (no app
  chrome, no input / capture / secret / voice / sketch components);
- no `href`, `src`, `style`, raw HTML props or `on*` handler props, and no
  markup or `javascript:` / `data:text/html` strings anywhere;
- every `*Key` (and the declaration's `titleKey`) must exist in
  `user-facing-vocabulary.json`;
- a `sandboxed-iframe` view has one `views/*.html` document instead (§8);
  the capability allowlist holds only `action.request` (iframe views), so any
  other capability is rejected;
- each action targets one of the plugin's own `provides.ops` (cross-plugin
  action ops are denied regardless of the grant), its `paramsSchema` must
  compile and close every object with `additionalProperties: false`, and the
  document may only reference declared action ids.

Serving (`listPluginViewsForViewer`, Chronos route): only `activatable`
managed records are read — a pending, broken or digest-mismatched plugin's
files are never opened. Documents are read through secure-io with each path
segment checked (no `..`, no symlink, regular file, size cap). The viewer's
role must meet `roleGate.minRole`, the viewer must hold every tier in
`roleGate.tiers`, and a plugin installed for a tenant is only visible to
viewers scoped to that tenant. The `tier` / `tenant` query parameters are
authorized against the viewer first and can only narrow.

Actions (`POST`): `chronos.plugin_view.action` is a localadmin write
operation. Unknown actions are 404, an op the plugin does not provide is 403,
invalid params are 400, a non-activatable plugin is 403. `authority: human`
creates a human-only approval request (bound to plugin, content digest, grant
digest, view, action, op and params; expires after 24 hours) in the Chronos
approval queue; `authority: agent` dispatches through op preflight only when
the owning plugin is active in the serving process, otherwise 409 — the web
surface imports plugin code only through its plugin host (§7), which is off
by default.

Executing an approved human action (FU-02): the same `POST` with
`approval_request_id`. Chronos shows the requests of visible views to
localadmin viewers; each carries `executable` (approved, and the approved copy
runs in the serving process under the approved grant) and, when an approved
request cannot run there, `unavailable_reason`. Only an executable request
gets an Execute button; otherwise Chronos explains why. The executor needs
localadmin and must see the view (another tenant's plugin is 404). The server
recomputes the payload hash from the current plugin (tenant, content + grant
digest), view, action and params and refuses (403) anything the approval does
not cover, so changed params, a reinstalled plugin or the same package
reinstalled for another tenant cannot reuse it; requests are listed only for
the view of the same tenant. The approval must be approved by an authenticated
human and unexpired (otherwise 409). Execution also requires the module
running in this process to be the approved copy (activation content digest)
under the approved grant (the active binding's grant digest equals the
record's `permissionsDigest`; a legacy unwrapped plugin never qualifies); a
re-approved package or grant must be reloaded first (409). Op preflight may
not rewrite the approved params (403); the handler always receives exactly
the approved params. Every check and the op preflight run before the approval
is claimed, so a refusal never spends it; the claim is an exclusive create
next to the request, so a second execution is 409. A `plugin_view.action.started`
audit event is written after the claim and before the handler; the result is
then recorded on the approval (`applyResult`) and audited
(`plugin_view.action.execute`). Every refusal — unknown approval, unavailable
op, digest mismatch, preflight denial — is audited too. A recording failure
never turns a success into a failure or masks the handler's error; a claim
without a recorded result (crash mid-execution) is listed as `unknown`, never
as executed, and cannot be executed again.

Self-approval policy: the requester may also approve and execute (Kyberion is
commonly run by a single localadmin operator). It is not blocked; every audit
event carries `self_approved: true` when the approver is also the requester or
the executor, so reviews can find it.

Request sidecars are named by request time; a listing reads only the newest
200, and queueing a new request prunes sidecars older than 7 days whose
approval is terminal.

## 7. In-process plugin host (PH-01)

`createPluginHost` (surface-agnostic) keeps a process's activations in line
with the managed install directory. Each sync lists the managed records and
activates eligible records that are not active, reloads an active plugin whose
approved content or grant digest changed, and deactivates plugins whose record
disappeared, is no longer `activatable` or is out of scope. Eligible =
`activatable` and tenant-less or bound to a tenant in the host's allowlist;
other tenants' records are dropped by the listing and never digested or
imported. Operations are registered process-wide, so the tenant allowlist is
the isolation boundary (and the tenant is part of every action approval
hash). Syncs are single-flight (requests during a run coalesce into one
follow-up) and a per-record fingerprint gates lifecycle calls, so polling an
unchanged directory never re-imports a module. Import failures are recorded as
`refused` and never crash the surface. Every activate / deactivate / refuse is
audited (`plugin_host.*`); `status()` carries codes and digest prefixes only.
The host lives on `globalThis[Symbol.for('kyberion.pluginHost.<surface>')]`,
so dev-server reloads and separately bundled route modules share one host.

Chronos: `src/instrumentation.ts` (Node.js runtime only) calls
`ensureChronosPluginHost()`, which is idempotent and a no-op unless
`KYBERION_CHRONOS_PLUGIN_HOST` is set. `KYBERION_CHRONOS_PLUGIN_HOST_TENANTS`
is a comma list of tenants (each must resolve in the tenant registry; reserved
scope names are rejected; unset = only tenant-less shared plugins);
`KYBERION_PLUGIN_HOST_POLL_MS` tunes the poll (default 30 s). A boot failure
is logged and leaves the host off (actions stay unavailable, Chronos keeps
running). The plugin-views `GET` and `POST` also call `ensureChronosPluginHost()`,
and the `POST` awaits one `syncNow()` before dispatching or executing, so an
approval never runs against a stale activation. The `GET` payload carries
`host`: a readonly viewer gets `{ enabled }` only; a localadmin also gets
per-plugin `state` / `reason_code` / digest prefix for the plugins of their
tenant scope. The Chronos plugin-views screen shows a badge (host disabled /
N plugins active / N refused) and explains a non-executable approved request
(host disabled, host refused the plugin, or reload pending).

Limits: reloads keep the previous module in memory until the process exits;
the host is still cooperative enforcement (§4), so enable it only where you
would run the approved plugins with the surface's own privileges.

## 8. Sandboxed-iframe views (PH-02)

A `sandboxed-iframe` view declares one self-contained `views/*.html`
document (≤ 512 KB strict UTF-8; same path rules as A2UI documents — no
symlink, contained in the managed copy). `plugin-view-frame.ts` rejects obvious
remote loads early (`<base>`, `http-equiv`, `http:` / `https:` / protocol-
relative URL attributes); the CSP and the iframe sandbox are the real defence.
`LoadedPluginView.html` carries the validated document; `messages` is empty and
`composePluginViewsA2UI` skips iframe views. The listing never inlines the
document: it lists `isolation`, `capabilities` and a same-origin `frame_url`.

Serving: `GET /api/headless/a2ui/plugin-views/frame?plugin_id=…&view_id=…` uses
the listing's authorization chain (`guardRequest` → `requireChronosAccess('readonly')`
→ server-resolved viewer → `chronos.plugin_view.read` → the view must be
visible). An invisible view (role / tier gate, another tenant, unknown, or an
A2UI view) is 404; a plugin in the viewer's scope that is not `activatable`
(tampered, pending) is 403. The response headers are exactly
`pluginViewFrameResponseHeaders()`:

- `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
  — the `sandbox` directive gives the document an opaque origin even when it
  is opened directly, and nothing can be fetched;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, and a
  `Permissions-Policy` that disables camera, microphone, geolocation,
  clipboard, fullscreen, payment, USB and the other powerful features.

Chronos pages send `Content-Security-Policy: frame-src 'self'` (`next.config.mjs`,
API routes excluded so the frame route keeps a single policy); deliverable PDF
previews are therefore framed only for same-origin URLs (external references
keep the open link).

Embedding (`PluginViewFrame.tsx`): `<iframe sandbox="allow-scripts" allow=""
referrerPolicy="no-referrer">` — never `allow-same-origin`, forms, popups or
top navigation — labelled "Plugin content".

Messages (`lib/plugin-view-frame-broker.ts`, pure and unit-tested): protocol
`kyberion.plugin-view/1`. The host accepts a message only when
`event.source` is the view's own frame window (the origin is the opaque
`"null"`, so it is useless), the data is plain JSON-like data (plain objects /
arrays, bounded depth, no class instances or cycles) of at most 16 KB, and the
shape is exact (`ready`, `resize { height }`, `action.request { requestId,
actionId, params }`; unknown keys are dropped). `ready` is answered with an
`init` message that carries the locale only; `resize` heights are clamped to
120–2000 px. `action.request` needs the `action.request` capability and an
action the view declares; one request may be in flight (`PLUGIN_VIEW_FRAME_BUSY`)
and at most 10 per minute are accepted (`PLUGIN_VIEW_FRAME_RATE_LIMITED`). Every
accepted request opens a host confirm dialog showing the plugin, view, action
and params (the Allow button arms after a short delay so a dialog that opens
under the pointer cannot take a stray click); only then does the host send the
existing plugin-views `POST`. A `human` action therefore only becomes an
approval request — execution stays on the host's Execute button after a person
approves it. The frame receives `action.result { requestId, status, errorCode? }`
with codes only. Replies are posted with target `*` (the only option for an
opaque origin); they never carry data beyond these codes.

Personal pads (PH-03) compose only A2UI views, read-only: iframe views are
reported as unsupported there, action references are stripped, and human
actions must be approved in Chronos.

## 9. Known gaps

- View text props are literal plugin strings (the catalog has no key props);
  only keys are vocabulary-checked.
- The Chronos plugin host is opt-in; without it approved human view actions
  are listed with `executable: false` and cannot be executed from Chronos.
- The iframe document can navigate its own frame (the sandbox has no
  top-navigation, but self-navigation is not blockable by CSP); it keeps its
  `contentWindow`, so every request it sends still passes the confirm dialog.
