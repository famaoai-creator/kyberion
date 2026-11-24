---
category: Fixed
---

- **Personal approvals from the terminal** — `pnpm kyberion approvals` now lists and decides the installed owner's personal-scope requests (for example the `onboarding authority` activation) in the canonical checkout, without exporting `KYBERION_TIER` / `KYBERION_NHI_ID`; `--new-window` therefore works for them too. Human-only requests still need the interactive A2 terminal challenge outside an agent session.
- **Onboarding authority link** — the request's `approval_url` now opens the Concierge authority card (`/settings#settings-authority`) instead of an unrouted Home query.
