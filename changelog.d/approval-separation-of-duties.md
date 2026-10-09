---
category: Added
---

- **Approval separation of duties (opt-in)** — `separation_of_duties.enabled` in `approval-policy.json` (default `false`, also settable in a customer overlay). When on, the approval store refuses an approval whose decider is the same principal as the requester (`[POLICY_VIOLATION] Separation of duties`), on every surface and again at apply time, and audits the refusal. Identities are compared after normalisation (case, Unicode, `user:`/`agent:`-style prefixes); a request with no recorded requester is refused while it is on. Agent-requested, human-approved requests keep working.
- **Pasteable attestation apply command** — `pnpm onboarding llm attest … --request-approval` and `pnpm tenant attest-provider … --request-approval` now print the follow-up apply command with every bound value (plan, basis, attested-by, valid-for-days) shell-quoted instead of `...`, so it applies as-is.
