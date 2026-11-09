---
category: Fixed
---

- Writer leases now reject exhausted or unsafe fencing counters, invalid clock values and non-finite or non-future expiry calculations before initial allocation. Fresh ownership checks remain enforced, and valid fractional durations and auto-renewed tokens remain supported.
