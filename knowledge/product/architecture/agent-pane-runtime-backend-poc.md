---
title: Agent Pane Runtime Backend PoC
category: Architecture
tags: [architecture, agent-runtime, pane-runtime, terminal, observability, poc, seam]
importance: 6
author: Ecosystem Architect
last_updated: 2026-09-21
---

# Agent Pane Runtime Backend PoC

## Goal

Prove that Kyberion can optionally launch live agents inside operator-visible
terminal-multiplexer panes, while keeping spawn/ask/shutdown ownership in
`agent-lifecycle`. Concrete multiplexer vendors register on the
`agent-pane-runtime-bridge` seam; core callers never name a vendor.

## Launch modes

| Mode             | How to select           | Behavior                                                           |
| ---------------- | ----------------------- | ------------------------------------------------------------------ |
| `pipe` (default) | unset / explicit `pipe` | Existing ACP / exec adapters over stdio pipes                      |
| `pane`           | explicit `pane`         | Pane-runtime seam: interactive provider CLIs in a visible mux pane |

Precedence (first wins):

1. `SpawnOptions.runtimeBackend` / `ensureAgentRuntime({ runtimeBackend })`
2. `runtimeMetadata.runtime_backend`
3. A2A payload `context.runtime_backend` or top-level `runtime_backend`
4. `KYBERION_AGENT_RUNTIME_BACKEND` env

Related knobs:

- `KYBERION_AGENT_PANE_RUNTIME_PROVIDER` — seam provider id (`auto` if unset)
- `KYBERION_AGENT_PANE_RUNTIME_BIN` — provider CLI path override (else tool-runtime `herdr`)
- `KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL` — workspace label (default `kyberion`)

## Tool lifecycle

The pane multiplexer binary is a governed tool-runtime entry (`herdr`):

```bash
pnpm tool:setup -- --tool herdr            # inspect
pnpm tool:setup -- --tool herdr --apply    # brew install herdr + mark installed
pnpm tool:setup -- --list                  # inventory all tool-runtime ids
```

Related camera/audio tools used by neighboring seams:

- `imagesnap` — virtual-camera-capture on macOS
- `blackhole-2ch` — audio-bus `blackhole` provider (cask; reboot may be required)

```bash
pnpm tool:setup -- --tools herdr,imagesnap,blackhole-2ch --apply
```

`system-actuator` `list_tool_runtimes` surfaces the same inventory.

## Seam shape

- Declaration: `libs/core/agent-pane-runtime-bridge.ts`
- First vendor adapter: `libs/core/agent-pane-runtime-herdr.ts` (vendor name stays here only)
- Lifecycle / A2A consume `pipe` \| `pane` only

## Smoke

```bash
KYBERION_AGENT_RUNTIME_BACKEND=pane pnpm exec tsx scripts/smoke_agent_pane_runtime.ts
```

## Boundaries kept

- Mission / board / evidence authority stays in Kyberion
- Pane runtime is an optional display + interactive launch substrate
- Vendor binaries remain external dependencies (not vendored)
- Headless CI should keep the default `pipe` mode
