# Privacy & Telemetry

What Kyberion does and doesn't do with your data.

## TL;DR

- **No telemetry by default.** Nothing leaves your machine unless you explicitly opt in or configure an external service.
- **Your data lives on your disk.** Kyberion stores configuration, missions, and traces under your local filesystem (or your customer/ overlay).
- **External AI calls are explicit.** When Kyberion uses an LLM (Anthropic, OpenAI, Gemini, Claude CLI, etc.), the request goes to that provider — see §3 below.
- **Secrets stay in OS keychain.** Kyberion uses `secret-actuator` to read credentials from your OS keychain. They never appear in committed files.

## 1. What Kyberion Stores Locally

| Path | Contents |
|---|---|
| `knowledge/personal/` | Your identity, vision, connections, voice profile. **Gitignored.** |
| `customer/{slug}/` | FDE customer configs (when `KYBERION_CUSTOMER` is set). **Gitignored** except `_template/`. |
| `active/missions/{id}/` | Per-mission git repo, state, evidence. **Gitignored.** |
| `active/shared/logs/traces/` | Structured execution traces (JSONL). **Gitignored.** |
| `active/shared/runtime/` | Runtime state, locks, surface metadata. **Gitignored.** |
| `active/audit/*.jsonl` | Audit ledger entries. **Gitignored.** |
| `knowledge/confidential/{project}/` | Project-scoped confidential knowledge. **Gitignored.** |
| `knowledge/public/` | Public reusable knowledge. **Committed** (intentionally shared). |

The `.gitignore` policy is enforced — see the file for the canonical list.

## 2. What Kyberion Does NOT Do by Default

- ❌ Send any data to a Kyberion-operated server (there isn't one).
- ❌ Send anonymous usage stats or crash reports.
- ❌ Phone home for license / activation checks.
- ❌ Read files outside the project root (enforced by `secure-io` and `path-scope-policy.json`).
- ❌ Use your data for training any model.

## 3. External Services You Opt Into

When you configure these, Kyberion sends data **to that provider on your behalf**, not to Kyberion:

| Service | What gets sent | When |
|---|---|---|
| Anthropic / Claude | The conversation context + tool calls | When you select the `anthropic` reasoning backend |
| OpenAI / Codex | Same | When you select the `codex-cli` backend |
| Google Gemini CLI | Same | When you select the `gemini-cli` backend |
| Local Claude CLI | Same, but routed through your local CLI | When you select `claude-cli` |
| Style-Bert-VITS2 (local) | TTS text → local server, no network egress | When you opt into local voice (Phase 2) |
| Whisper (local) | STT audio → local server, no network egress | When you opt into local voice (Phase 2) |
| Slack / Google Workspace / Notion | Whatever the connection is configured to read/write | When you wire those connections |

You always know which backend is active — `pnpm doctor` and CLI logs print it on startup.

## 4. Egress Redaction

When sending to external LLMs, Kyberion attempts to redact:

- Strings matching common API key patterns (`sk-…`, `AIza…`, etc.).
- Values that flow from `secret-actuator` reads.
- File paths inside `knowledge/personal/` and `customer/{slug}/secrets.json`.

This is best-effort, not a security boundary. **Treat any data you ask Kyberion to process as potentially sent to the LLM provider.** For sensitive data, run with `KYBERION_REASONING_BACKEND=stub` (offline) or self-host an inference endpoint.

A stronger redaction layer is a Phase C' deliverable (see `PRODUCTIZATION_ROADMAP.md` G-GV-3).

## 5. Audit Chain

Every state-changing action emits an entry to `active/audit/audit-{date}.jsonl`. This is:

- **Append-only** in normal operation.
- Optionally anchored to a public blockchain via `blockchain-actuator` (opt-in only).
- **Local-only** by default — no remote audit service.

For FDE / customer engagements, you can configure the audit chain to also write to a customer-controlled location.

## 6. If You Want Telemetry (Future, Opt-in)

Phase B-7 of the roadmap introduces an opt-in anonymous telemetry layer:

- Anonymous crash reports.
- Anonymous "scenario succeeded / failed in N seconds" stats.
- Sent to a maintainer-controlled aggregator.
- **Off by default. Per-execution opt-in. Easy to inspect what's being sent.**

The exact aggregator endpoint and data shape will be documented in this file before that feature ships.

## 7. Reporting a Privacy Issue

See `SECURITY.md` for vulnerability disclosure. Privacy-specific concerns can also be raised as GitHub Issues with the `privacy` label.

## 8. Compliance

Kyberion is a software toolkit, not a service. Compliance posture (GDPR, FISC, SOC2 etc.) is determined by **how you deploy it**:

- Self-hosted / OSS: you control all data flows.
- FDE / customer deployment: the customer's compliance posture applies; configure tier scope and egress redaction accordingly.
- Future Kyberion-managed offering: the eventual privacy notice will be specific to that offering and not implied here.

For deeper compliance work in customer engagements, see `knowledge/public/fisc-compliance/` and the customer aggregation guide.
