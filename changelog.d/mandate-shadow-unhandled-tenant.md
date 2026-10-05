---
category: Added
---

- **Shadow mode for standing mandates (包括委任)** — when a mission brief goes to you for plan approval, Kyberion now records whether a standing mandate (`knowledge/product/governance/standing-mandates.json`: test strengthening, documentation, lint/type fixes, each with allowed paths, a risk ceiling and an expiry) would have covered it, and later records your decision. Nothing changes for you: the plan approval stays yours and is never skipped. The ledger (`active/shared/runtime/mandate-shadow/`) is the agreement evidence for deciding later whether mandates may start missions on their own; a covered mission you rejected counts as a false positive and blocks that.
