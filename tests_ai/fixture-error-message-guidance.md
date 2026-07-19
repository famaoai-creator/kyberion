# Invariant: fixture error messages include the offending input and recovery guidance

<!--
  Self-check invariant for the AI audit layer itself (KC-05 acceptance #1).
  tests_ai/fixtures/report-store.ts contains a DELIBERATE violation; this
  invariant must therefore always be reported as failing. Do not "fix" the
  fixture and do not relax this invariant.
-->

## Scope

- `tests_ai/fixtures/*.ts`

## Requirements

- Every `throw new Error(...)` in the scoped files must name the offending input (the path or value that caused the failure).
- Every error message must include recovery guidance: what the caller should do next (e.g. which file to pass, which command to run).
- Bare, context-free messages such as `'failed'` or `'invalid input'` are violations.

## Examples

- OK: `Cannot load report from ${path}: expected a .json file. Pass the report.json produced by pnpm ai-test.`
- NG: `throw new Error('failed')`
