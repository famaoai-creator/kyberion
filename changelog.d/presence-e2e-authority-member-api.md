---
category: Fixed
---

- Unify charter and approval stores under the primary checkout so delegated authority granted in concierge is honored from linked worktrees instead of re-requesting human approval on every action.
- Stop recording a failed apply receipt when an approval request was never bound to a suspended pipeline run, which previously poisoned `can_apply` and silently dropped the real outcome.
- Fix the OAuth consent "連携する" button navigating to `about:blank` by keeping the popup window handle (`window.open` with a `noopener` feature always returns null).
- Expose concierge settings through the `kyberion-base` A2UI catalog: headless `concierge.settings.read` and `concierge.settings.a2ui` projections render the same viewer-scoped setup state as the HTML page.
- Add a member-API sweep gate so a route that exists but is not in the member allowlist (the silent `TypeError: Unsupported member API path` class) fails in CI instead of the UI.
