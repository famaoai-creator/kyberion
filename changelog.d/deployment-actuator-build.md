---
category: Fixed
---

- `pnpm build` passes again on `main`. Since #1374, the deployment actuator's `defineActuator` handler received an `unknown` input, which failed type-checking (`TS2739: Type '{}' is missing the following properties from type 'DeploymentParams'`). The handler now narrows the input through the same validator the SDK applies.
- The governance-import baseline generator now runs through the script harness. Instead of a package script, it is invoked directly as `node --import ./scripts/ts-loader.mjs scripts/generate_governance_import_baseline.ts`, which keeps `package.json` within the SX-05 script ratchet.
- `lease-backend.test.ts` uses deterministic gates instead of real-time sleeps.
