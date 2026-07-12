# Security Policy

How to report a security vulnerability in Kyberion.

## Supported Versions

Until v1.0.0, only the **latest released version** receives security fixes. After v1.0.0, the policy is:

| Version                        | Supported                                                   |
| ------------------------------ | ----------------------------------------------------------- |
| latest minor of latest major   | ✅ security + bug fixes                                     |
| latest minor of previous major | ✅ security only, for 90 days after the new major's release |
| anything older                 | ❌                                                          |

## Reporting a Vulnerability

**Do NOT** open a public GitHub issue for a security vulnerability.

**Do** one of the following:

1. **GitHub Security Advisories** (preferred):
   - Go to https://github.com/famaoai-creator/kyberion/security/advisories
   - Click "Report a vulnerability"
   - Fill in the form

2. **Email**:
   - **security@kyberion.dev** (TODO: set up; until then, email any core maintainer listed in [`MAINTAINERS.md`](./MAINTAINERS.md))
   - Subject: `[SECURITY] <brief description>`
   - Encrypt with PGP if you can; key fingerprint will be published once email is set up.

Please include:

- A clear description of the vulnerability.
- Steps to reproduce.
- Affected version(s) / commit hash(es).
- Your assessment of impact.
- Whether you've disclosed this elsewhere.

## What to Expect

| When                | What                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| Within 48 hours     | Acknowledgement that we received your report.                               |
| Within 7 days       | Initial triage assessment: severity, affected components.                   |
| Within 30 days      | Fix in `main`, plus a draft GitHub Security Advisory ready for publication. |
| Coordinated release | Public advisory + patched release. We coordinate timing with the reporter.  |

If we cannot reproduce or do not consider the report a vulnerability, we will explain our reasoning. You can request reconsideration.

## Disclosure Policy

We follow **coordinated disclosure**:

1. Reporter notifies us privately.
2. We confirm and develop a fix.
3. We agree on a public disclosure date with the reporter (typically 60–90 days from initial report, sooner if actively exploited).
4. On the disclosure date: patched release + public advisory + credit to the reporter (unless they decline).

If a vulnerability is being actively exploited in the wild, we may shorten the timeline.

## Scope

In scope:

- The Kyberion codebase in this repository.
- Released Docker images under `ghcr.io/famaoai-creator/kyberion-*`.
- The build / release supply chain.

Out of scope:

- Third-party dependencies (please report to the upstream project; we monitor and update).
- The user's own deployment misconfiguration (we provide guidance, but each operator is responsible for their environment).
- Social engineering or phishing.
- DoS attacks against demos / playgrounds running this code (these are not our infrastructure).
- Bugs that are not security-related (use regular GitHub issues).

## Shell & ADF Execution Guardrails (SA-02)

Kyberion enforces layered guardrails around agent-initiated execution:

- **Shell command policy** (`libs/core/shell-command-policy.ts` + `knowledge/product/governance/shell-command-policy.json`): commands are parsed (executable + arguments, not substring matching) and evaluated against a denylist and an allowlist. Anything unmatched defaults to `require_approval` (**fail-closed**), including when the policy file is missing.
- **Sub-agent Bash gating** (`libs/core/claude-agent-governance.ts`): sub-agents get no unconditional Bash; every command runs through the shell policy, and non-`allow` verdicts are denied with the reason surfaced. The ACP mediator applies the same policy and denies unmatched tool calls by default.
- **ADF static guardrails** (`libs/core/adf-guardrails.ts`): validated pipelines are additionally scanned before execution — command hooks against the shell policy, HTTP targets against the egress policy, and step/loop limits against governance caps. `readValidatedPipelineAdf` rejects pipelines with error-severity findings.
- **Runtime bounds** (`libs/core/execution-bounds.ts`): shared step-count / wall-clock / loop-iteration backstops (`[SAFETY_LIMIT]`) used by pipeline engines as the last line of defense.

These guardrails are one layer of defense in depth against naive-to-moderate dangerous commands — they are **not** a sandbox. Full isolation (containers/eBPF) is tracked as future work in `docs/developer/improvement-plans-2026-07/SA-02_ADF_SHELL_GUARDRAILS.ja.md`.

## Declarative Policy Engine & Kill Switch (SA-05)

- **Policy engine** (`libs/core/policy-engine.ts` + `knowledge/product/governance/agent-policies.yaml`): declarative rules (tier isolation, injection guards, ring restrictions, delegation depth, rate limits) evaluated at real execution junctions — `file_write` (secure-io), `execute_command` (safeExec/safeExecResult), `network_request` (secureFetch), and `reasoning_delegation` (before any provider call, with delegation depth tracked via `KYBERION_DELEGATION_DEPTH`). Parse failures load zero policies and `evaluate()` **fails closed**; policies whose rules fail to parse are dropped with a warning, and doctor reports declared-vs-loaded counts so silent shrink is visible.
- **Approval unification**: shell-policy `require_approval` verdicts (sub-agent Bash, ACP tool calls) route through `requireApprovalForOp` — a pending approval request is filed for the operator and the call stays denied (fail-closed) until approved.
- **Kill switch** (`libs/core/kill-switch.ts`): policy violations and actuator dispatches feed anomaly detection (thresholds in `knowledge/product/governance/trust-policy.json`); the monitor runs with run_pipeline / mission controller / the runtime supervisor. Graduated response: warn → isolate → kill, where kill always requires operator approval (no automatic kill).
- **Visibility**: `pnpm doctor` prints the governance summary — kill-switch state, policy counts (declared/loaded), pending approvals, shell/egress rule counts, and current anomaly findings.

## Hall of Fame

We credit reporters here unless they request anonymity.

| Reporter   | Vulnerability | Disclosed |
| ---------- | ------------- | --------- |
| _none yet_ | —             | —         |

## Why This Matters

Kyberion executes browser automation, talks to LLMs, and reads from your filesystem. A vulnerability could:

- Leak `customer/{slug}/` or `knowledge/personal/` content to an LLM provider.
- Bypass tier-guard and read confidential knowledge across customers.
- Execute arbitrary commands via a malformed ADF pipeline.
- Persist malicious state into a mission's git repo.

We take these seriously. Thank you for reporting responsibly.
