# OS Automation Bridge Model

## Intent

Kyberion should not treat AppleScript, `cliclick`, or platform-specific shell snippets as ad hoc actuator logic.
They belong to a shared physical automation layer that can be reused by any higher-level actuator or surface.

This model defines a two-layer split for OS automation:

- `L0: OS Automation Bridge`
  - Executes platform-specific primitives such as Apple Events, accessibility queries, and low-level input synthesis.
  - Owns script templating, escaping, and environment adaptation.
- `L1: Intent Actuators`
  - Expose human-meaningful actions such as `activate_application`, `detect_focused_input`, or `empty_trash`.
  - Apply governance, approval, and mission-local policy.

## Design Principles

1. `computer_interaction` remains the canonical cross-provider contract.
2. Platform-specific implementation details live in `@agent/core`, not inline in each actuator.
3. Destructive or privacy-sensitive actions stay in L1 so they can be policy-gated.
4. L0 returns structured observations rather than raw AppleScript output whenever possible.

## Initial L0 Scope

The first bridge should cover only the primitives already used by `system-actuator`:

- activate application
- detect focused input
- type keystroke text
- paste text atomically
- press special keys
- click / move mouse

This keeps the initial extraction narrow while stopping further AppleScript drift.

## Why This Matters

Without a dedicated bridge, OS automation logic fragments across:

- `system-actuator`
- future desktop/browser helpers
- terminal bridges
- environment doctor checks

That makes governance, testing, and environment adaptation harder.

With the bridge:

- L0 stays reusable
- L1 stays explainable
- Chronos can reason about logical actions without caring about AppleScript details
- future adapters for Chrome, Finder, Terminal, or iTerm can share the same execution substrate

## Recommended Evolution

1. Extract the current macOS AppleScript helpers into a shared bridge.
2. Add known-app logical adapters on top of the bridge.
3. Add environment doctor checks for `cliclick` and display calibration.
4. Add approval gates for destructive logical actions.
5. Only then consider richer discovery such as SDEF inspection.

## Known App Adapters

Known app adapters sit above the bridge and below intent actuators.
They expose logical operations for specific desktop applications without leaking AppleScript into the actuator layer.

Initial adapters should be small and explicit:

- `Google Chrome`
  - `list_tabs`
  - `activate_tab_by_title`
- `Finder`
  - `empty_trash`
- `Terminal` / `iTerm2`
  - capability metadata and activation

These adapters should remain declarative and human-auditable.
If richer support is needed later, SDEF-based discovery can extend them without changing the L1 contract.
