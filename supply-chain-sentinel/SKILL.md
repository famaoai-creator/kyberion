---
name: supply-chain-sentinel
description: Protects the software supply chain by generating SBoMs and auditing dependency provenance. Monitors for malicious packages and maintenance risks.
---

# Supply Chain Sentinel

This skill ensures the integrity of everything your software depends on.

## Capabilities

### 1. SBoM Generation
- Generates a **Software Bill of Materials (SBoM)** in CycloneDX or SPDX formats.
- Lists all direct and transitive dependencies with their hashes and origin.

### 2. Provenance & Risk Audit
- Analyzes dependency maintenance health (e.g., commit frequency, open issues).
- Flags potential "typosquatting" or known malicious package patterns.

## Usage
- "Generate an SBoM for our production release."
- "Audit our supply chain for packages with poor maintenance or suspicious origins."
