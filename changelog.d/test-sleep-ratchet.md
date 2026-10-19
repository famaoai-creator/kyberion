---
category: Added
---

- **`test-sleep-ratchet` PR gate** — real-time sleeps in test files (`setTimeout(resolve, N)`, `await sleep(N)`) may now only decrease per file; a new one fails `pnpm check -- --scope pr` with its `file:line` and the deterministic replacement (fake `Date` + `vi.setSystemTime`, `vi.advanceTimersByTimeAsync`, `vi.waitFor`, a deferred gate, or an injected clock). Run it alone with `pnpm check -- --only test-sleep-ratchet`; after removing sleeps, lower the baseline with `node --import ./scripts/ts-loader.mjs scripts/check_test_sleep_ratchet.ts --write-baseline`. The riskiest existing TTL / deadline / ordering sleeps were converted (97 → 76).
