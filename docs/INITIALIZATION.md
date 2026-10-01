# Kyberion Initialization Guide (Day-2 Command Reference)

This document is the detailed command reference for the day-2 initialization steps that follow the first win, plus per-environment notes. A Japanese edition is kept in [INITIALIZATION.ja.md](./INITIALIZATION.ja.md); this English file is canonical ([localization policy](./DOCUMENTATION_LOCALIZATION_POLICY.md)).

- **Start with [QUICKSTART.md](./QUICKSTART.md).** It is the single front door and owns the first-win sequence and the [onboarding entry points table](./QUICKSTART.md#onboarding-entry-points).
- **The order of steps and the route split (personal only / AI company / add an existing tenant) is canonical in the [onboarding standard flow](../knowledge/product/governance/onboarding-flow.md).** When in doubt, read that first.
- The canonical source per document category is listed in [documentation-source-map.json](./documentation-source-map.json).

## Quick commands

If you have not run the first win yet, finish the five commands in QUICKSTART.md first.

# kyberion-first-win

```bash
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm kyberion doctor
pnpm pipeline --input pipelines/verify-session.json
```

Kyberion's readiness check is `pnpm kyberion doctor` (`pnpm run doctor` runs the same check). A bare `pnpm doctor`, without `run` or `kyberion`, is pnpm's built-in diagnostic (registry/cache) and does not run Kyberion's checks.

After the first win, continue in the order of the standard flow:

```bash
# Check readiness in one pass (standard flow Step 2)
pnpm kyberion setup report --persona first-time-user
pnpm surfaces reconcile

# Choose a stance, then save the identity (Step 3)
pnpm stance:switch <customer-slug>   # only when working as a customer / company
pnpm onboarding

# Bring the baseline to all_clear (Step 4)
pnpm pipeline --input pipelines/baseline-check.json
```

The personal-only route ends here; continue with the health check below. If you work with tenants, continue with standard flow Steps 5-8.

## Prerequisites

- Node.js `24+` (`engines` in `package.json` is the source of truth; `.nvmrc` is also `24`; `nvm use` aligns it)
- `pnpm`
- `git`

On Windows, install the base tools from PowerShell with winget.

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id pnpm.pnpm --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements
```

To use local AI assistance on Windows (Foundry Local), also run the following. It is optional.

```powershell
winget install --id Microsoft.FoundryLocal --exact --source winget --accept-source-agreements --accept-package-agreements
```

After installing, start the Foundry Local API and, if needed, set `KYBERION_WINDOWS_AI_ENDPOINT` and `KYBERION_WINDOWS_AI_MODEL`.

Reopen PowerShell after installing and continue with the normal steps. If you use an existing governed manifest, check what is missing and apply it with approval:

```powershell
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm env:bootstrap --manifest kyberion-toolchain --apply --force
```

---

## Detailed process and physical effects

How each stage maps to a step of the standard flow:

| Stage | Content                                 | Standard flow |
| ----- | --------------------------------------- | ------------- |
| 1-3   | Install, build, prerequisite tool check | Step 1        |
| 4-5   | Readiness and starting surfaces         | Step 2        |
| 6-7   | Choose a stance and save the identity   | Step 3        |
| 8     | Bring the baseline to all_clear         | Step 4        |
| 9     | Tenant, organization, activation        | Steps 5-8     |

### Stage 1: Physical foundation

- **Command**: `pnpm install`
- **Purpose**: load every library and wire up the internal modules.
- **Physical changes**:
  - `node_modules/` is created.
  - Symlinks between workspaces (such as `@agent/core`) are built.

### Stage 2: System manifestation

- **Command**: `pnpm build`
- **Purpose**: compile the dependencies and produce runnable JavaScript. Many later commands (`env:bootstrap`, `doctor`, parts of `onboarding`) use `dist/`, so do this stage first.
- **Physical changes**:
  - The `dist/` directory is created.
  - The Chronos (`presence/displays/chronos-mirror-v2/.next/`) and concierge UIs are built (`build:ui`).
  - Runtime contracts between workspaces are rebuilt.
- **Build steps**: `build:packages` -> `build:actuators` -> terminal-hud -> `build:repo` -> `build:ui`. To rebuild only the UI, use `pnpm build:ui`.

### Stage 3: Prerequisite toolchain check

- **Command**: `pnpm env:bootstrap --manifest kyberion-toolchain`
- **Purpose**: confirm that the basic tools for running Kyberion from source (Node / pnpm / git / TypeScript / tsx / vitest, and so on) are present.
- **Notes on the checks**:
  - **Node floor**: compares the running Node version with `engines` in `package.json` (`>=24.0.0`) and, if it is too old, fails and suggests `nvm install 24 && nvm use 24`.
  - **Playwright browsers**: if the browser cache (`ms-playwright`) is missing, a **non-fatal warning** suggests `pnpm exec playwright install chromium`. Install it if you want the browser first win. Browsers are not downloaded automatically in postinstall.
- **Physical changes**:
  - None. Missing tools and local dependencies are summarized.

### Python runtime resolution

- Python-based bridges resolve their interpreter in this order: `KYBERION_PYTHON_BIN` -> `KYBERION_PYTHON` -> managed runtime (`active/shared/runtime/tool-runtimes/*/bin/python`) -> `.venv/bin/python3` -> `python3`.
- `.venv/bin/python3` is a repo-local candidate kept for legacy compatibility and is not the new standard.
- To use the AGY native subagent, install the official SDK into a managed runtime with `pnpm agy:sdk-setup --apply` (internally `uv venv` + `uv pip install`). Python 3.10+ is required; override the interpreter with `KYBERION_AGY_SDK_PYTHON`.
- Kyberion's custom agent definitions for the AGY CLI are generated into `.agents/agents/` by `pnpm agents:generate`. To list them manually use `agy --add-dir "$PWD" agent`; to pick one use `agy --add-dir "$PWD" --agent kyberion-implementer ...`. `AgyCliBackend` passes the workspace to `--add-dir` automatically.
- To use several Google accounts on one machine: the AGY CLI normally uses `~/.gemini/antigravity-cli/`, but profiles created with `pnpm kyberion agy profile add <name>` (`~/.agy-profiles/<name>`) isolate accounts. Install into the host with `pnpm kyberion agy profile setup-host`, and select an account for the Kyberion reasoning backend with `KYBERION_AGY_PROFILE=<name>` (details: [`antigravity-multi-account-operations.md`](../knowledge/product/orchestration/antigravity-multi-account-operations.md)).
- Custom subagent definitions for the Devin CLI are generated by the same `pnpm agents:generate` into `.devin/agents/` (role names as-is: `implementer` / `reviewer` / `devils_advocate`). Devin's `allowed-tools` is a strict allowlist, so the `kyberion-*` definitions in `.agents/agents/` (for AGY) cannot resolve tool names there and effectively have no tools. Under Devin, use the names in `.devin/agents/`.
- Custom subagent definitions for Cursor are generated into `.cursor/agents/` (role names as-is). Cursor has no `tools:` allowlist in frontmatter and inherits the parent agent's tools (including MCP). Read-only roles use `readonly: true` to suppress writes and state-changing shell commands. Example invocations: `/implementer` / `/reviewer` / `/devils_advocate`.
- Custom subagent definitions for the Codex CLI are generated into `.codex/agents/` (TOML, role names as-is: `implementer` / `reviewer` / `devils_advocate`). `sandbox_mode` is projected from the KD-05 authority tier: implementers get `workspace-write`, investigators and reviewers get `read-only`.
- Voice samples and promoted voice profile data live under `active/shared/tmp/` or `active/shared/runtime/voice-profiles/<profile_id>/`.

### Stage 4: Check readiness

- **Command**: `pnpm kyberion setup report --persona first-time-user`
- **Purpose**: check surface / service / reasoning / doctor readiness in one pass and find the gaps in the initial setup. Run this first, then use the individual commands below only for the items it reports.
- **Physical changes**: none.

#### 4a. Runtime surface setup

- **Command**: `pnpm surfaces setup`
- **Purpose**: for background surfaces such as `concierge`, `presence-studio`, `chronos-mirror-v2`, `voice-hub`, `slack-bridge`, `imessage-bridge`, `discord-bridge`, `telegram-bridge`, `nexus-daemon` and `terminal-bridge`, show missing auth items, CLI alternatives, and host-managed surfaces.
- **Helpers**:
  - `pnpm surfaces status` shows what is running.
  - `pnpm surfaces repair -- --surface <surface-id>` restarts a stale or unhealthy surface.
  - `pnpm surfaces start -- --surface <surface-id>` / `pnpm surfaces stop -- --surface <surface-id>` start or stop one surface.

#### 4b. External service setup and preflight

- **Command**: `pnpm service:setup`
- **Purpose**: for service presets such as GitHub, Google Workspace, Slack, Notion and Jira, show the required secrets, CLI alternatives, and where customer/personal connections live. Nothing is changed.
- **Check right before use**: `pnpm service:preflight -- --service <service-id>`. `service:setup` is "preparation"; `service:preflight` is "can I use it now". It fails if auth is missing.
  - Services with bridge health, such as `voice` / `meeting`
  - Services where auth and CLI health are checked together, such as `google-workspace`
  - Services that depend on a local runtime, such as `media-generation`. This is the entry point for checking whether a runtime such as ComfyUI is reachable. If it fails, check that ComfyUI is running, provisioned, and pointed at the right endpoint.
- **Registering a secret**: for a secret that `service:setup` reports missing, use `pnpm kyberion secret introduce <service-id> <secret-key>`.
  - The value is never accepted on argv. Enter it at a hidden TTY prompt, or pass a file under `active/shared/tmp/` with `--from-file <path>`.
  - It is a two-phase propose and apply. If it is auto-approved locally, it is applied immediately. If approval is pending, follow the output: `pnpm kyberion approve <approval-id>`, then `pnpm kyberion secret apply <approval-id> --from-file <path>`. Add `--no-auto-approve` to opt out of auto-approval.
  - Check registration with `pnpm kyberion secret status <service-id>`. Values are never printed.
  - In the GUI, the concierge `/settings` -> "Service connections" offers the same flow.
  - Never write values directly into connection JSON or `.env`.

#### 4c. Reasoning backend setup

- **Command**: `pnpm reasoning:setup`
- **Purpose**: see which reasoning backends this host can use. The source of truth for candidates is `allowed_modes` in `knowledge/product/governance/reasoning-backend-policy.json`; the main ones are:
  - Local CLIs: `claude-cli` / `codex-cli` / `gemini-cli` / `agy-cli` / `grok-cli` / `copilot` / `cursor-cli` / `opencode-cli`
  - APIs: `anthropic` / `claude-agent` / `gemini-api` / `grok-api` / `openrouter` / `nemotron-api`
  - Local models: `local` / `ollama` / `vllm` / `lmstudio` / `llamacpp` / `mlx` / `localai`
  - Offline / testing: `stub`
- **Physical changes**:
  - `KYBERION_REASONING_BACKEND` is saved to `.env.local` only if you pick a backend in interactive mode.
- **Known pitfall (claude-cli shadowing)**: until its postinstall is approved, the repo dependency `@anthropic-ai/claude-code` places a placeholder shim at `node_modules/.bin/claude`, which under pnpm can hide the real `claude` (for example `~/.local/bin/claude`) on PATH. If running `claude` prints `claude native binary not installed`, this is the cause. Fix: approve `@anthropic-ai/claude-code` with `pnpm approve-builds`, or set `KYBERION_CLAUDE_CLI_BIN=$HOME/.local/bin/claude` (the probe falls back to `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and so on when it detects the placeholder, but an explicit setting is the most reliable).

#### 4d. Per-feature dependencies and system tools

- **Per-actuator dependencies**: `pnpm deps:check --actuator browser|voice|media-generation`. Check only that feature's dependencies before you use it.
- **System tools**: list with `pnpm tool:setup -- --list` and install with `pnpm tool:setup -- --tool <tool> --apply`. A tool that declares `managed_binary`, such as lightpanda, installs a checksum-pinned upstream release into the managed env.

### Stage 5: Runtime surface reconciliation

- **Command**: `pnpm surfaces reconcile`
- **Purpose**: start the background surfaces from the manifest, based on what setup found. The concierge (secretary room, `http://127.0.0.1:3050`) also starts here, which makes the Stage 7 GUI route available.
- **Physical changes**:
  - `active/shared/runtime/surfaces/state.json` is created or updated.
  - Per-surface logs are written to `active/shared/logs/surfaces/`.
  - Surface runtimes are registered with `runtime-supervisor`.

### Stage 6: Choose a stance

Where the identity is saved, and where baseline-check L3 looks, depends on the active stance. Decide **before saving the identity**.

- Use as yourself: leave `KYBERION_CUSTOMER` unset. The destination is `knowledge/personal/`.
- Use as a customer / company: switch with `pnpm stance:switch <customer-slug>` (create the overlay first with `pnpm stance:create <customer-slug>` if it does not exist). The destination is `customer/{slug}/`.

### Stage 7: Soul infusion (identity)

- **Command**: `pnpm onboarding` (needs `dist/`)
- **Purpose**: make the system remember the sovereign's name, language, interaction style, specialty, and vision.
- **To do it in the GUI**: open the concierge `/settings` (the old `/setup` and `/onboarding` redirect there). Save the identity under "About you", and register members and approvers under "Organization and members". The approver is later given as `--owner-id` in tenant activation.
- **In a non-interactive environment**: without a TTY, `pnpm onboarding` stops with exit 2. Use one of these instead:
  - `pnpm onboarding apply --identity <path/to/identity.json>` — apply the identity from a JSON file (Path B)
    - Copy the template [`knowledge/public/templates/onboarding/identity.example.json`](../knowledge/public/templates/onboarding/identity.example.json). Validating with `--dry-run` first is safest.
  - `KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1 pnpm onboarding` — proceed with default values on purpose (for evaluation environments)
- **To start over**: `pnpm onboarding reset` removes the onboarding state and the generated identity / vision / agent artifacts.
- **Physical changes**:
  - `customer/{slug}/my-identity.json` is created. When `KYBERION_CUSTOMER` is unset, it is `knowledge/personal/my-identity.json`.
  - `customer/{slug}/my-vision.md` is created (or updated). When `KYBERION_CUSTOMER` is unset, it is `knowledge/personal/my-vision.md`.
  - `customer/{slug}/onboarding/onboarding-state.json` and `onboarding-summary.md` are created. When `KYBERION_CUSTOMER` is unset, they are under `knowledge/personal/onboarding/`.
  - At the end of identity setup the agent introduces itself and agrees an Agent ID (its public name for A2A communication and records) with the sovereign. `customer/{slug}/agent-identity.json` is created; with `KYBERION_CUSTOMER` unset, `knowledge/personal/agent-identity.json`.
  - Service connection candidates (`connections/*.json`), tenant candidates, and the first tutorial plan (`onboarding/tutorial-plan.md`) are created under the same profile. They are candidates; no external side effects occur.

### Stage 8: Bring the baseline to all_clear

- **Command**: `pnpm pipeline --input pipelines/baseline-check.json`
- **Purpose**: confirm that every judgment layer L0-L11 passes. The layers are listed in standard flow Step 0.
- **Layers that often fail the first time**:
  - **L8 (storage janitor)**: baseline-check enqueues the janitor automatically. Re-run after it completes. To run it by hand: `pnpm pipeline --input pipelines/storage-janitor.json --context '{"dry_run":false}'`.
  - **L10 (scheduler)**: passes when no schedule is enabled. After registering schedules, keep the chronos daemon resident. On macOS, `pnpm kyberion scheduler install` shows what it will do and `--apply` registers a LaunchAgent. To just run it in the foreground, use `pnpm scheduler`. The same ceremony registers the media generation scheduler and the daemon watchdog (a 5-minute one-shot) with `--daemon generation-schedule` / `--daemon daemon-watchdog`. The node binary passed to launchd resolves to `<prefix>/opt/node/bin/node` (a version-independent symlink), so `brew upgrade node` does not break it.
  - **L11 (audit ledger)**: fails if there are no audit records, or they are stale. Governed operations such as Stage 7 record them.

### Stage 9: Tenant, organization, activation (only when needed)

For personal-only use this stage is not needed. If you work with tenants, run Steps 5-8 of the [standard flow](../knowledge/product/governance/onboarding-flow.md) in order. Here are the three distinct things those steps tie together.

| What it refers to                         | Role                                                             | Where it lives                                  |
| ----------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| **customer-slug** (stance / acting party) | "Which party am I acting as right now" — **runtime setting**     | `customer/{slug}/` + `KYBERION_CUSTOMER`        |
| **tenant-slug** (tenant)                  | "Inside which confidentiality boundary am I" — **data boundary** | `knowledge/confidential/{tenant-slug}/`         |
| **organization-id** (organization)        | "How that tenant is run" — the operating model under the tenant  | `active/organizations/{tier}/{tenant}/{org_id}` |

`customer-slug` and `tenant-slug` are often spelled the same but are not the same thing (one is a setting, the other a boundary). The containment order is canonical in [entity-scope-hierarchy](../knowledge/product/architecture/entity-scope-hierarchy.md); the three-way distinction is in [stance-tenant-customer-model](../knowledge/product/architecture/stance-tenant-customer-model.md). A tenant's own customers live in `knowledge/confidential/{tenant-slug}/customers/`, not in `customer/{slug}/`.

To start as an AI company, `pnpm onboarding company --vertical <vertical> --slug <company-slug> --name "<company name>" --owner-id human:<owner> --goal "<first outcome>" --tenant-slug <tenant-slug> --dry-run` previews tenant registration and context binding together. AI workers can prepare and execute work, but final decisions on contracts, payments, external publication and permission changes stay with the human given as `--owner-id`. Company onboarding does not complete activation automatically.

---

## Vital check

To confirm onboarding completed correctly, run:

```bash
pnpm pipeline vital-check
pnpm pipeline --input pipelines/baseline-check.json
```

**Expected output (example)**:

- [OK] Physical Foundation (node_modules)
- [OK] System Build (dist)
- [OK] Sovereign Identity
- [OK] Sovereign Vision
- [OK] Onboarding Summary

You are done when the baseline-check `status` is `all_clear`.

---

_Status: Mandated by AGENTS.md — day-2 command reference (ONB-02)_
_Last Updated: 2026-10-01_
