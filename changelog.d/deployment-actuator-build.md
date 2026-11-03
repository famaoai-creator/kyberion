---
category: Fixed
---

- `pnpm build` passes again on `main`. Since #1374, the deployment actuator's `defineActuator` handler received an `unknown` input, which failed type-checking (`TS2739: Type '{}' is missing the following properties from type 'DeploymentParams'`). The handler now narrows the input through the same validator the SDK applies.
