# Solution Mapping Rules

This document defines the rules for classifying GitHub repositories into business solutions based on name patterns and descriptions.

## Mapping Table

| Solution Category             | Keywords / Patterns                                                        | Description                                                  |
| :---------------------------- | :------------------------------------------------------------------------- | :----------------------------------------------------------- |
| **Customer Portal (CP)**      | `project_a-`, `online-banking`, `project_b_`, `generic_whitelabel`, `generic_api` | Customer-facing banking applications (Web/App).              |
| **AuthSystem (Auth)**         | `auth_sys`, `auth_system`                                                  | Identity verification and authentication services.           |
| **Identity Verification Solution**       | `service-c_`, `identity-verify`                                                             | Electronic Know Your Customer and C-3 platform components.   |
| **Auth Infrastructure** | `identity-provider-`, `auth-logic`, `auth-server`, `secure-auth`                                 | Identity providers and authentication infrastructure.        |
| **Digital Assets**   | `transfer-`, `digital-wallet-`, `dlt-network-`, `asset-token-`                                   | Remittance, digital wallet, and blockchain-related services. |
| **Cloud Infrastructure**      | `cloud-platform-`, `reliability-`, `aws-`, `terraform-`, `ansible-`, `infra-ops-`                 | Infrastructure, PaaS, and SRE tools for the financial cloud. |
| **Core System**               | `core_sys`, `bank_core`                                                    | Core banking systems and ledger management.                  |
| **Distributed Ledger**          | `dlt-core-`, `gate-way-`                                                         | Canton and specialized blockchain infrastructure.            |
| **Common / Library**          | `common-`, `lproject_a-`, `util-`                                                 | Shared components used across multiple solutions.            |
| **PoC / Verification**        | `mock-`, `sample-`, `test-`, `verif-`                                      | Prototypes and verification environments.                    |

## Maintenance Status Criteria

- **Active**: Updated within the last 6 months.
- **Maintenance**: Updated between 6 months and 1 year ago.
- **Stale (Archive Recommended)**: Not updated for more than 1 year.
