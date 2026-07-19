# Invariant: secure-io access denials identify the target and classify the cause

## Scope

- `libs/core/secure-io.ts`
- `libs/core/tier-guard.ts`

## Requirements

- Every error thrown when a file read or write is **denied** (permission guard, policy engine, tier guard) must identify the target path — either directly in the thrown message or via the interpolated guard `reason`.
- Denial messages must carry a machine-greppable bracketed classification tag such as `[SECURITY]`, `[POLICY_BLOCKED]`, or `[POLICY_VIOLATION]`, so log scrapers and the error classifier can distinguish governance denials from ordinary I/O failures.
- When the policy engine itself cannot be evaluated (missing/broken policy file), the write must **fail closed** with an explicit error — never silently fall through to an allow.

## Examples

- OK: `[SECURITY] Read access denied to ${filePath}: ${guard.reason}`
- OK: `[POLICY_VIOLATION] tenant.scope_violation — persona bound to X attempted to access path of tenant 'Y' ('path').`
- NG: `throw new Error('access denied')` — no path, no classification tag.
- NG: catching a policy-engine load failure and proceeding with the write.
