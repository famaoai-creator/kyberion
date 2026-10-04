---
category: Added
---

- **Dot key-result measurement engine** — `measureDotKeyResults` / `measureOrganizationKeyResults` measure `goal.key_results` (probe, repo-confined file, signal ratio, organization metric) and objective KRs into the dot and org KR ledgers, honouring `every_s` and a 15 s probe timeout. Wake prompts gain a "Largest goal gap first" section, the digest and `dot status` gain key-result sections, and the supervisor runs a `dot-kr-measure` step per sweep.
