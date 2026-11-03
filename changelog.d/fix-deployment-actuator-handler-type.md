---
category: Fixed
---

- Fix `deployment-actuator` `deploy_release` handler losing its `DeploymentParams` input type (implicit `unknown` broke `pnpm build:repo` / repository build on main); annotate the parameter per the actuator-sdk typed-handler pattern.
