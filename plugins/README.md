# Plugins

Extend skill execution with beforeSkill/afterSkill lifecycle hooks.

## Agent Plugins v1 portable package

`plugins/kyberion-agent-plugin/` is the additive Agent Plugins v1.0.0 package
for reusable Kyberion skills and the portable MCP declaration. It contains the
standard root `plugin.json`, optional root `mcp.json`, and `skills/` directory.

The existing `plugins/kyberion-claude-code/` and `plugins/kyberion/` directories
remain client-specific compatibility packages. Claude hooks/commands and
Cowork governance metadata are intentionally kept there; they are not part of
the portable Agent Plugins core.

## Usage

Create `.kyberion-plugins.json` in your working directory:

```json
{
  "plugins": ["./plugins/execution-guard.js", "./plugins/perf-profiler.js"]
}
```

Plugins are loaded automatically by `runSkillAsync()` (`libs/core/skill-wrapper.ts`)
through the KD-06 provenance-trust gate in `libs/core/skill-plugin-loader.ts` —
**before any configured path is imported**, it must resolve (symlinks
followed) to one of:

- **official** — inside this repo's own `plugins/` tree (the in-tree plugins
  listed below), or
- a **managed-copy install** (`installPluginManaged`,
  `libs/core/plugin-managed-install.ts`) whose activation status is
  `activatable` — official-by-provenance, or third-party with a human
  `approved` decision already applied.

Anything else — an arbitrary path, or a managed install that is
`pending_approval`, `blocked_broken_manifest` or `blocked_digest_mismatch` — is **skipped with a logged
diagnostic and its code is never executed**. A skipped plugin never blocks
the skill run (fail-open display), but "fail-open" never means "execute
anyway" (fail-closed execution).

To stage a third-party plugin as a managed copy:

```bash
pnpm plugin:install --source ./some/plugin --id my-plugin
```

This prints the derived trust label and, for anything non-official, the
pending approval request id and how to decide it:

```bash
pnpm kyberion approvals
pnpm kyberion approve <request-id> <storage-channel>
```

Only after that decision is `approved` does the managed copy become
loadable — re-run `pnpm plugin:install` (or point a pipeline at
`refreshManagedPluginActivation`) to see the updated status.

## Available Plugins

| Plugin                 | Hooks              | Purpose                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------- |
| `metrics-collector.js` | `afterSkill`       | In-memory execution metrics collection                     |
| `output-logger.js`     | `afterSkill`       | JSONL logging to `work/plugin-output.log`                  |
| `execution-guard.js`   | `before` + `after` | File type blocking, audit logging, slow execution warnings |
| `tier-enforcer.js`     | `afterSkill`       | Scans outputs for leaked confidential markers              |
| `perf-profiler.js`     | `afterSkill`       | Performance regression detection (rolling window)          |

## Configuration

### execution-guard

| Env Var                  | Default  | Description                                            |
| ------------------------ | -------- | ------------------------------------------------------ |
| `GUARD_BLOCKED_EXTS`     | _(none)_ | Comma-separated blocked extensions (e.g., `.exe,.bat`) |
| `GUARD_WARN_DURATION_MS` | `5000`   | Slow execution warning threshold                       |

### perf-profiler

Stores rolling performance data in `work/perf-profile.json`. Warns when execution time exceeds 2× the historical average.

## Writing a Plugin

Plugins are ESM modules (this repo runs with `"type": "module"`):

```javascript
export const beforeSkill = (skillName, args) => {
  // Called before skill execution
};

export const afterSkill = (skillName, output) => {
  // Called after skill execution
  // output: { status, data, metadata, error }
};
```

Approved plugins may also declare governed runtime contributions in their
manifest. The names in `provides` are an allowlist: the exported
`registerKyberionContributions(api)` callback must register every executable
entry, and activation is rolled back if a name is undeclared or missing.

```json
{
  "plugin_id": "example-pack",
  "provides": {
    "ops": ["example:run"],
    "providers": ["stub"],
    "hooks": ["settlement-audit"],
    "prompt_sections": ["operator-note"],
    "facets": ["example-policy"]
  }
}
```

Contribution activation is provenance-gated and reversible. `ops` are
resolved through the actuator registry, `providers` through the governed
reasoning-provider registry, hooks through the lifecycle engine, and
prompt/facet entries carry the plugin provenance. Deactivation disposes
all registrations; a manifest alone never grants execution authority.

**Rules:**

- Plugins MUST NOT throw errors that break skill execution
- Non-stub reasoning providers MUST pass a versioned live conformance receipt
  when they register. The prompt, structured-output, and abort checks must be
  `verified`; usage may remain `declared` when it is recorded at the adapter
  boundary. An offline receipt records what was not exercised but cannot grant
  activation authority.
- Each hook is wrapped in try-catch by the skill-wrapper
- Plugins load in array order; a failing plugin doesn't block others
- A plugin path is only ever `import()`-ed if it passes the trust gate above
  — writing a plugin doesn't make it trusted; provenance does

## Permissions declaration and narrowing (EP-02)

A manifest may declare what the plugin needs. Anything not declared is
`none` — deny by default:

```json
{
  "permissions": {
    "network": { "mode": "allowlist", "hosts": ["api.example.com"] },
    "fs": { "mode": "readonly", "paths": [{ "tier": "public", "prefix": "" }] },
    "ops_invoke": ["example:*"],
    "env": ["EXAMPLE_*"],
    "secrets": ["EXAMPLE_TOKEN"]
  }
}
```

At install time the request is intersected with the per-trust ceiling in
`knowledge/product/governance/plugin-permission-policy.json` and, with
`--tenant <slug>`, with that tenant's narrow-only override. Confidential paths
are confined to the installing tenant. `pnpm plugin:install` prints the
requested / ceiling / granted table before any approval request exists. If a
critical capability (fs, network, secrets) is narrowed to nothing, nothing is
installed and the error names the elevation an administrator would have to
grant (`PluginPermissionNarrowedError`). The narrowed grant — not the request —
is what a human approves.

## Digest-bound approval and re-approval (EP-01)

An approval is bound to the managed copy's content digest (sha256 over every
file), the manifest version and the digest of the granted permissions. Every
activation check recomputes them, and the loader re-verifies the digest
immediately before `import()`. Any change — code, manifest or a view
document — makes the plugin `blocked_digest_mismatch` until it is reinstalled
and the new version is approved (`pnpm plugin:install --source ... --id ...`,
then decide the new request). Approving the old request does nothing; the
concierge plugin screen answers such an approval with a "reinstall" message.

The approval covers exactly one manifest, at the package root. A package with
more than one root candidate (`manifest_ambiguous`) or any candidate below the
root (`manifest_nested`, e.g. `dist/plugin.json`) is `blocked_broken_manifest`,
and runtime readers of a managed install only consult the root manifest.

Managed records written before digests existed are treated as
`pending_approval`: reinstall each legacy third-party plugin once and approve
it again. Official plugins are not affected.

## Runtime enforcement (EP-03)

Plugin permission grants are enforced cooperatively. Kyberion runs every
contribution a plugin registers inside `runWithPluginGrant`, which applies
the intersection of the enclosing sandbox policy and the approved grant and
never widens it, and records the executing plugin so op preflight
(`ops_invoke`), secret-guard (`secrets`) and `getPluginEnv()` (`env`) can
check the grant. This mediates Kyberion's governed paths only (secure-io
writes, sandbox/URL network checks, op dispatch, secret resolution). It is
not a security boundary against malicious in-process code: a plugin that
imports `node:fs`, opens sockets directly or reads `process.env` is not
stopped, and filesystem reads are not restricted. Third-party plugins without
a declaration run with the empty grant; official plugins without a
declaration keep the legacy trusted path. Approve only plugins you would run
with the host's own privileges.

### Reserved seams

A plugin may never provide `core-clock`, `risky-approval-handler`,
`risky-approval-override` or `scenario-op-override` (they would let plugin
code decide approvals, replace op resolution or move the governed clock). A
manifest that declares one is a broken manifest; a registration attempt fails
closed.

## Lifecycle and the apply ladder (EP-04)

Long-running hosts manage one live activation per plugin
(`libs/core/plugin-lifecycle.ts`). Every registration is recorded in an
ownership ledger; a plugin can only dispose contributions it owns.

```bash
pnpm plugin:install --reload <plugin-id>      # re-verify, classify, apply
pnpm plugin:install --deactivate <plugin-id>  # dispose everything it owns
```

Both act on the current process only. A change is applied on the least
disruptive rung:

| Mode               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `config_apply`     | permissions narrowed in place, or a change confined to `views/`            |
| `plugin_reload`    | ops / hooks / prompt sections / facets / code changed, permissions widened |
| `restart_required` | seams or providers changed (consumers may hold references)                 |

A reload re-imports the entry with a `?digest=` query; Node keeps the
previous module in memory until the process exits, so hosts that reload
often should restart periodically. If the new module fails, the previous
module is re-activated; if that fails too, the plugin stays inactive and the
result is `restart_required`. The ladder never bypasses the approval: even a
`config_apply` change changes the content digest and needs a re-approval
before the new version is activatable (`reloadPlugin` does not know which
paths changed, so a re-approved content change is applied as
`plugin_reload`). Installing a new version replaces the managed copy in
place, so a reload while that version awaits approval **deactivates** the
running one (fail closed — the old module could lazily load unapproved
files); it comes back once the new version is approved and reloaded. The same
happens when the managed copy is removed, tampered with, or its approval is
rejected.

## Views (EP-05)

A plugin may contribute declarative views — A2UI documents, never code:

```json
{
  "provides": {
    "ops": ["example:refresh"],
    "views": [
      {
        "id": "status",
        "titleKey": "plugin:fixture_status_view_title",
        "document": "views/status.a2ui.json",
        "isolation": "in-process-a2ui",
        "capabilities": [],
        "roleGate": { "minRole": "readonly", "tiers": ["public"] },
        "actions": [
          {
            "id": "refresh",
            "authority": "agent",
            "op": "example:refresh",
            "paramsSchema": { "type": "object", "properties": {}, "additionalProperties": false }
          }
        ],
        "lifecycle": { "refresh": "on_open" }
      }
    ]
  }
}
```

Rules (`libs/core/plugin-view-contract.ts`,
`knowledge/product/schemas/plugin-view-declaration.schema.json`):

- The document lives under `views/` inside the plugin (no `..`, no symlinks)
  and is a list of A2UI messages: one `createSurface` with catalog
  `kyberion-base`, then `updateComponents` / `updateDataModel`.
- Only a display-only subset of `ui:*` components is allowed; props are
  validated against the catalog schema; no `href`, raw HTML, script URLs or
  event-handler props; every `*Key` must exist in the user-facing vocabulary.
- `sandboxed-iframe` isolation is reserved (`[PLUGIN_VIEW_UNSUPPORTED]`) and
  every capability is denied for now.
- Actions may only target the plugin's own `provides.ops`; `paramsSchema`
  must set `additionalProperties: false` on every object. The document may
  only reference declared actions. `authority: "human"` queues a human-only
  approval request; `authority: "agent"` dispatches only where the plugin is
  active in-process.
- Once a person approves a `human` action, a localadmin executes it once
  (`POST` with the same `plugin_id` / `view_id` / `action_id` / `params` plus
  `approval_request_id`, or the Execute button in the Chronos plugin-views
  screen). The approval is bound to the plugin, view, action, op, params,
  content digest and grant digest, expires after 24 hours, and runs through
  the same op preflight and grant as an agent action (409 when the plugin is
  not active in the serving process). A second execution is 409 and every
  attempt is written to the audit chain.
- Views are served (Chronos `GET /api/headless/a2ui/plugin-views`) only for
  `activatable` managed plugins whose digest still matches; the viewer's role,
  tier and tenant are evaluated server-side and a `tier` / `tenant` query can
  only narrow them.

`plugins/fixtures/plugin-permissions-fixture/` is the reference fixture (ops,
permissions and one view). Design and threat model:
[plugin-permissions-and-views](../knowledge/product/architecture/plugin-permissions-and-views.md).

## End-to-end check (PE-01 / PE-02)

`plugins/fixtures/plugin-view-e2e-fixture/` is a minimal third-party plugin:
one `sandboxed-iframe` view (`views/panel.html`) that asks the host to run an
`agent` action (`ping`) and a `human` action (`stamp`) over `postMessage`.
Both handlers are harmless; the host records the observable outcome.

```bash
pnpm build                               # dist scripts + the Chronos production build
pnpm exec playwright install chromium    # once
pnpm kyberion check plugin-views-e2e     # ~15 s; --keep-root keeps the hermetic root
```

`scripts/check_plugin_views_e2e.ts` builds a hermetic Kyberion root under
`active/shared/tmp/plugin-views-e2e/<run>/` (never the real `active/` or
`knowledge/`), installs the fixture with `plugin_install --tenant` from outside
that root's `plugins/` tree (so it is third-party), approves the install with
the operator CLI, and starts `next start` on a free loopback port with
`KYBERION_CHRONOS_PLUGIN_HOST` enabled for that one tenant and a random
localadmin token. Playwright Chromium then lists the plugin views, opens the
iframe view, clicks inside it, confirms in the host dialog, and runs the agent
action and the human action (approval request, CLI approval, Execute in
Chronos, a second execution refused with 409). It asserts on data only: the
listing, the frame response headers, what the sandboxed document observed
(opaque origin, `connect-src` violation), the approval records and the audit
chain. The browser, the server and the hermetic root are removed also on
failure or on the overall timeout (100 s); a failure prints the step timings
and the Chronos log tail. CI runs it in the `first-win-clean-clone` job.

## Release notes (EP-01 to EP-05)

Upgrading a host that already has managed plugins:

- Legacy third-party managed records (written before digest-bound approval)
  are `pending_approval`: reinstall each one and approve it again.
- Packages that contain a plugin manifest candidate below their root —
  including anywhere under `node_modules/`, matched case-insensitively — are
  rejected (`manifest_nested`); package trees too large to scan (more than
  20,000 entries or deeper than 32 levels, e.g. a bundled `node_modules`) fail
  closed (`manifest_tree_too_large`) at install and at activation — slim the
  package (bundle the code) and reinstall.
- Follow every reinstall with a reload in each long-running host
  (`pnpm plugin:install --reload <plugin-id>`): revocation and grant changes
  are enforced when the plugin is reloaded, not while the old activation runs.
- Lowering a ceiling in `plugin-permission-policy.json` (or a tenant
  override) can block an already installed plugin until it is reinstalled and
  its narrowed grant approved.
