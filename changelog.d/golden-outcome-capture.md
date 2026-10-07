---
category: Added
---

- **Recorder captures the success message as a check anchor** — while recording, the Chrome extension now records a `role="status"` message that appears after an action and settles (e.g. "Saved") as a reviewable `wait_for_ref` step, so the procedure's golden scenario checks the result instead of the weak "the control just clicked is still visible" fallback. Alerts, messages already shown before the action, intermediate states ("Saving…") and text the PII scrubber redacted are not captured. On replay the message is found by its text. Click-only recordings that previously always came out `inconclusive` now get a pass/fail verdict.
