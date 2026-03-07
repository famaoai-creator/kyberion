# Procedure: License & Supply Chain Audit

## 1. Goal
Audit third-party dependencies for risky licenses (GPL, etc.) and verify the integrity of the software supply chain.

## 2. Dependencies
- **Actuator**: `Code-Actuator`

## 3. Step-by-Step Instructions
1.  **Dependency Inventory**: Use `Code-Actuator` with the `test` action to run `npm list --json` or `pnpm list --json`.
2.  **License Extraction**: Parse the command output to identify license types for each dependency.
3.  **Risk Identification**: Match found licenses against the banned list:
    - **Risky**: `GPL`, `AGPL`, `LGPL`.
    - **Safe**: `MIT`, `Apache-2.0`, `ISC`.
4.  **Integrity Check**: Compare dependency versions against the lockfile (`pnpm-lock.yaml`) using `File-Actuator`.

## 4. Expected Output
A compliance status report for all third-party dependencies.
