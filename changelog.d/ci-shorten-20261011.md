---
category: Changed
---

- **CI test matrix sharding** — `test (scripts)` (~11min tail) splits into `--shard=1/3…3/3` and `test (integration)` into 2 shards via vitest `--shard`, cutting the per-PR critical path by roughly half.
- **Vitest fsModuleCache** — transforms persist to `node_modules/.vitest-cache` and restore on CI via `actions/cache` in setup-kyberion, reclaiming the ~20-30% transform share of every test job.
- **`pnpm test` forwards `--shard`** — test_suite dispatcher passes Vitest options through unchanged; contract pinned in test_suite.test.ts.
