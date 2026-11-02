---
category: Changed
---

- **Managed-process identity and lifecycle honesty**: process and surface records now carry a start marker alongside the pid, stops and restarts refuse to signal a pid whose identity cannot be proven, failed cleanups retain ownership with the error recorded for retry, and spawn reports spawn_failed instead of claiming success for binaries that never started. Code-actuator analysis ops (impact_analysis, semgrep_scan, run_tests) now return evidence metadata (confidence, authority, limitations, unknowns), oversized results are retained under the cache floor with a reference and preview, and artifact writes fsync the parent directory after rename.
