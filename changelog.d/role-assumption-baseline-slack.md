---
category: Changed
---

- The `role-assumption-reachability` gate also ratchets, per system role, the child-process entries that inherit `SYSTEM_ROLE` (`child_process_entries` in `role-assumption-unresolved-baseline.json`), and warns — without failing — when a role's unresolved-site or child-process count falls below its baseline, naming the `--print-unresolved-baseline` command that lowers it.
- `child_process_entries` is required in the baseline schema and a missing map allows 0 per role (fail closed). `--print-unresolved-baseline` no longer reads the existing baseline, so the documented `> role-assumption-unresolved-baseline.json` redirect (which truncates the file first) regenerates it instead of failing.
