---
category: Fixed
---

- Replace unsalted API credential proof hashes with versioned, randomly salted scrypt verifiers and constant-time comparison. Legacy proofs require fresh explicit verification; registered keys are unchanged. Claimed task bindings compare their existing in-memory credentials directly, retaining immediate rotation checks without a KDF on every credential read.
