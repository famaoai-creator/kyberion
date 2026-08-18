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

Anything else — an arbitrary path, or a managed install still
`pending_approval`/`blocked_broken_manifest` — is **skipped with a logged
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
pnpm cli -- approvals
pnpm cli -- approve <request-id> <storage-channel>
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
