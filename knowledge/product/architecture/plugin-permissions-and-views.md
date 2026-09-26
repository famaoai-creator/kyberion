---
title: Plugin Permissions, Lifecycle and Views
category: Architecture
tags: [plugins, permissions, approval, digest, sandbox, lifecycle, a2ui, views, security]
importance: 7
last_updated: 2026-09-26
---

# Plugin Permissions, Lifecycle and Views

How Kyberion decides what an installed plugin may do, keeps that decision
bound to the exact code a human approved, applies changes with the least
disruption, and lets a plugin contribute UI without contributing UI code.
Operator-facing summary: [`plugins/README.md`](../../../plugins/README.md).
Plan: `docs/developer/improvement-plans-2026-09/ELIZA_ADOPTION_PLAN_2026-09-24.ja.md` §5 (EP-01〜EP-06).

## 1. Layers

| Layer                     | Module                                                                        | Decides                                                        |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Provenance trust (KD-06)  | `plugin-source-trust.ts`, `skill-plugin-loader.ts`                            | official / curated / third-party from the resolved location    |
| Approval binding (EP-01)  | `plugin-managed-install.ts`                                                   | approval ⇔ content digest + manifest version + grant digest    |
| Permission grant (EP-02)  | `plugin-permissions.ts`, `governance/plugin-permission-policy.json`           | request ∩ trust ceiling ∩ tenant override                      |
| Runtime mediation (EP-03) | `plugin-grant-runtime.ts`, `plugin-contributions.ts`, `sandbox-policy.ts`     | governed host paths check the executing plugin's grant         |
| Lifecycle (EP-04)         | `plugin-lifecycle.ts`, `scripts/plugin_install.ts --reload/--deactivate`      | ownership ledger, activate / reload / deactivate, apply ladder |
| Views (EP-05)             | `plugin-view-contract.ts`, Chronos `GET/POST /api/headless/a2ui/plugin-views` | declarative A2UI documents, viewer gating, action routing      |

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
- `sandboxed-iframe` is rejected with `[PLUGIN_VIEW_UNSUPPORTED]`; the
  capability allowlist is empty, so any capability is rejected;
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
surface never imports plugin code.

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

## 7. Known gaps

- View text props are literal plugin strings (the catalog has no key props);
  only keys are vocabulary-checked.
- `sandboxed-iframe`, view capabilities and personal-pads composition are
  follow-ups (plan §8).
- Nothing activates plugins inside the Chronos server process (only the
  `plugin_install` CLI activates them, in its own process), so approved human
  view actions are listed with `executable: false` and cannot be executed from
  Chronos yet. Activating approved plugins inside the Chronos process is a
  follow-up.
