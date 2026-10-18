---
category: Fixed
---

- L2 baseline observations no longer consume the compiler recovery budget. Compiler builds and baseline scans share a lock; busy builds defer readiness checks instead of triggering recovery.
- Baseline state retains failure timestamps, fingerprints, source/output evidence and completed repair outcomes without overwriting concurrent layer updates.
- GitHub CLI diagnostics distinguish DNS/network and credential-store failures from confirmed authentication rejection, and redact credentials from diagnostic output.
