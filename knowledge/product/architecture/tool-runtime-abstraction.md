---
title: Tool Runtime Abstraction
category: Architecture
tags: [runtime, package-manager, uvx, npx, venv, install, policy]
importance: 7
last_updated: 2026-06-04
---

# Tool Runtime Abstraction

Kyberion does not treat `uvx`, `npx`, `pipx`, `brew`, or `uv` as arbitrary shell trivia. They are runtime mechanisms that must be governed by a shared policy.

## Core Idea

The user-facing intent is about the tool outcome:

- trial a tool without installing it first
- approve and install a tool into a governed environment
- re-run an already installed tool
- pin a tool version and its managed location

The runtime layer resolves the concrete backend and path handling.

## Layers

1. `tool-runtime-policy`
   - Governs default runtime modes, managed roots, and approval requirements.
   - Example: `KYBERION_TOOL_RUNTIME_POLICY_PATH`.

2. `tool-runtime-registry`
   - Declares per-tool launch plans, install plans, and managed environment roots.
   - First governed entry: `mflux` for Apple Silicon local FLUX generation.
   - The registry can also be queried as an inventory to show whether each tool is in `trial`, `approved_install`, `installed`, or `pinned` lifecycle state.

3. `tool-runtime-state`
   - Records whether a tool has been installed or pinned, and where it lives.
   - State is stored under the managed runtime root in `active/shared/runtime/`, with per-tool state in `tool-runtimes/<tool>/state.json`.

## Example: `mflux`

For local FLUX image generation, the runtime can:

- run trial execution through `uvx`
- install into a managed Python tool environment via `uv tool install`
- re-run the installed tool via `uv tool run`

The image generation bridge asks the runtime layer for the launch plan instead of hardcoding `uvx`.
Higher-level surfaces can call `listToolRuntimeInventory()` to present the current lifecycle of all governed tools in one place.

## Other Governed Examples

The registry is intentionally not limited to Python tools:

- `playwright`
  - Node / browser runtime example
  - Trial probe through `npx playwright --version`
  - Managed browser bootstrap through `pnpm exec playwright install chromium`
- `ffmpeg`
  - System media toolkit example
  - Trial probe through `ffmpeg -version`
  - Install through `brew install ffmpeg`
- `sox`
  - Audio toolkit example
  - Trial probe through `sox --version`
  - Install through `brew install sox`
- `tesseract`
  - OCR toolkit example
  - Trial probe through `tesseract --version`
  - Install through `brew install tesseract`

## Design Rule

Never bind user intent directly to a package manager.
Bind intent to the artifact or tool outcome, then let the runtime layer decide whether the tool should be tried, installed, reused, or pinned.
