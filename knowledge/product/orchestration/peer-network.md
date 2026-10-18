---
title: Peer Network Catalog
kind: orchestration
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [peer, messaging, transport, same-host, lan, catalog]
---

# Peer Network Catalog

Use this catalog to exchange messages between Kyberion instances.

同一 tenant の peer を初めて接続する場合は、先に [同一 tenant peer の最短手順](./same-tenant-peer-quickstart.ja.md) を実行してください。この文書は catalog、transport、collaboration の詳細を説明します。

通信パターンと trust / authority の正本は[Agent Communication and Coordination Model](../architecture/agent-communication-layer-model.md)です。same-host peer は別 Kyberion runtime 間の transport です。同じ checkout の provider CLI 同士の調整には Co-Session を使います。localhost は接続先の表現であり、認証や権限の付与ではありません。

## Files

- Schema: `knowledge/product/schemas/peer-network.schema.json`
- Default catalog: `knowledge/product/orchestration/peer-network.json`

## Transport model

- `peer:server` starts a Kyberion peer listener on an HTTP port.
- `peer:conversation-server` starts a conversation-capable Kyberion peer listener.
- `peer:register` stores a peer endpoint and shared secret in the tenant confidential catalog.
- `kyberion peer send` resolves a peer from the tenant catalog and sends a signed envelope.
- `peer:conversation` opens, sends, lists, and closes peer conversation sessions.
- `kyberion peer collaboration` lists and explicitly accepts or rejects governed proposals created from conversation handoffs.
- Messages are stored as inbox / outbox / event JSONL records under `active/shared/runtime/peer-messaging/tenants/{tenant}/peers/{peer}/` and `active/shared/observability/peer-messaging/tenants/{tenant}/peers/{peer}/`.
- Conversation sessions are stored under `active/shared/runtime/peer-conversations/tenants/{tenant}/peers/{peer}/` and `active/shared/observability/peer-conversations/tenants/{tenant}/peers/{peer}/`.
- Mesh Hub registrations, presence, capabilities, delivery ledger, proposals, and events use `.../mesh-hub/{namespace}/tenants/{tenant}/...`; a namespace may be empty.
- Direct Peer Messaging handles a received envelope synchronously and returns its success receipt after the responder finishes. Completed message IDs are deduplicated at the receiver; a concurrent duplicate receives retryable HTTP 425.
- The listener bounds responder concurrency and the number of requests waiting for a slot. Defaults are --max-inflight 8 and --max-queued 64; saturation returns retryable HTTP 503. Mesh presence publishes the listener's live capacity, which ranks eligible peers. An explicitly selected busy peer remains routable so the durable Mesh ledger can retry its retryable overload response.
- Governed Mesh requests use the persistent Mesh delivery ledger and mesh-delivery-driver: accepted deliveries survive driver restarts, retry with bounded exponential backoff, honor expiry, and move exhausted failures to dead-letter storage. The driver treats non-2xx transport receipts as retryable failures and preserves the broker's stable message ID across attempts.
- A successful Mesh delivery ACK means the receiver completed its synchronous handler. Explicit proposal acceptance and subsequent work execution remain separate states.

## Same-host workflow

同一 host でも別 Kyberion runtime として運用する場合に限り、Peer Messaging を使います。peer ID、listener port、共有 secret、runtime root / Mesh namespace を各 runtime で分けてください。同じ runtime root や journal に対する複数 writer はサポートしません。複数 provider CLI が同じ checkout を共有しているだけなら listener を起動せず Co-Session を使ってください。

1. Start one peer on `127.0.0.1:4100`.
2. Start another peer on `127.0.0.1:4101`.
3. On the sender host, register the remote peer with `pnpm peer:register --tenant-id demo --peer-id kyberion-local-b --base-url http://127.0.0.1:4101 --shared-secret-env KYBERION_PEER_SHARED_SECRET_B --exposure same_host`.
4. Send a message with `KYBERION_TENANT_ID=demo pnpm kyberion peer send --from-peer-id kyberion-local-a --to-peer-id kyberion-local-b --subject status --payload '{}'`.

## Same-host governed collaboration

Start a tenant-aware conversation peer. Supplying `--tenant-id` enrolls the peer,
advertises `peer.collaboration`, and maintains Mesh presence for the listener lifetime.

```bash
KYBERION_PEER_SHARED_SECRET='<secret>' pnpm peer:conversation-server \
  --peer-id kyberion-local-b \
  --host 127.0.0.1 \
  --port 4101 \
  --tenant-id default \
  --key-ref env:KYBERION_PEER_SHARED_SECRET
```

A `handoff` becomes a proposal only when its metadata contains a complete,
typed `collaboration_request` whose value is a valid `mesh-request`. Ordinary
conversation messages retain their existing behavior. The recipient checks the
signed sender, tenant, target peer, request kind, payload classification, and TTL
before persisting a pending proposal.

Inspect and decide proposals locally:

```bash
pnpm kyberion peer collaboration list --tenant-id default --peer-id kyberion-local-b --status pending
pnpm kyberion peer collaboration accept \
  --tenant-id default \
  --peer-id kyberion-local-b \
  --proposal-id <proposal-id> \
  --actor-id <operator-id> \
  --reason '<validation reason>'
```

Use `reject` instead of `accept` to reject a proposal. Decisions are append-only,
require an actor and reason, and cannot be overwritten. Acceptance records local
authorization only; it does not mutate mission state or automatically execute the
embedded WorkItem/A2A proposal.

## LAN workflow

1. Bind the peer listener to the machine's LAN address (`--host 192.168.x.y`). Binding to `0.0.0.0` also listens on the LAN, but the Mesh enrollment then records `127.0.0.1` as the endpoint.
2. Register the peer's LAN `base_url` in the catalog (`pnpm peer:register ... --exposure same_lan`).
3. Set `allow_local_network: true` (`same_lan` sets it).
4. Use the same `kyberion peer send` / `pnpm peer:conversation send-message` command and point it at the LAN peer ID. Each direction is verified with the receiver's own shared secret, so a two-way link needs a listener and a catalog entry on both sides.

## Conversation auto replies (opt-in)

A conversation server can answer inbound conversation messages with an LLM-generated reply, so two peers can hold a bounded autonomous conversation. It is off unless the operator names the remote peers:

```bash
KYBERION_PEER_SHARED_SECRET=... pnpm peer:conversation-server \
  --peer-id <local-peer> --host <lan-ip> --port 4100 --tenant-id <tenant> \
  --auto-reply-peers <remote-peer>[,<remote-peer>]
```

| Flag                           | Default     | Meaning                                                                                      |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------------------- |
| `--auto-reply-peers`           | empty (off) | Remote peers whose `message` / `reply` messages get an LLM reply                             |
| `--auto-reply-max-turns`       | 6           | Per-session cap on automatic replies; stops two auto-responders from looping                 |
| `--auto-reply-budget-per-hour` | 30          | Rolling per-peer generation budget (bounds session-rotation abuse and spend)                 |
| `--auto-reply-timeout-ms`      | 60000       | Generation timeout                                                                           |
| `--auto-reply-concurrency`     | 1           | Worker concurrency                                                                           |
| `--auto-reply-max-attempts`    | 3           | Delivery attempts per reply                                                                  |
| `--auto-reply-knowledge-limit` | 5           | Tenant knowledge excerpts used to ground a reply                                             |
| `--auto-reply-backend`         | `claude`    | Isolated text generator id (see the backend table below)                                     |
| `--auto-reply-allow-untested`  | false       | Version-gated backends only (`codex`): run on a version the isolation probe has not verified |

How it works:

- The HTTP receive path only records a reply job in `active/shared/runtime/peer-messaging/tenants/<tenant>/peers/<local-peer>/reply-jobs.jsonl` (keyed by `sender:message_id`, so redelivery never answers twice) and returns a `status` ACK. One server process owns that ledger per local peer.
- A worker generates the reply through an isolated text generator (`@agent/core/provider/isolated-text-generator`), resolved once at startup; an unknown backend id or one its reasoning-provider descriptor does not declare stops the server from starting (`ISOLATED_GENERATOR_UNKNOWN` / `ISOLATED_GENERATOR_UNDECLARED`). The dry run and the startup log show the backend id and its isolation level.
- With the default `claude` backend the worker runs `runClaudeAgentQuery` in strict isolation (no tools, no settings/hooks/MCP, scratch working directory, minimal environment) — never through the reasoning failover chain, whose other CLIs run with tools. Peer text and knowledge excerpts are framed as untrusted data.
- With `--auto-reply-backend codex` (for hosts that have the Codex CLI but no Claude), the worker runs `runCodexIsolatedQuery`: `codex exec` with user config, rules and session persistence ignored, a read-only sandbox, approvals `never`, web search off, no MCP servers and every tool-bearing feature disabled, in an empty scratch directory with only `PATH`/`HOME`/`USER`/`LANG`/`TMPDIR` (+ `CODEX_HOME`) in the environment. This is weaker than the Claude path in one honest respect: the Codex model still **sees** some tool definitions (exec, apply_patch, spawn_agent, MCP resource readers); they cannot execute — attempts fail closed inside the CLI — and any observed tool attempt (a `tools::router` stderr line or a non-message `--json` item) discards the reply, recorded as `generation_failed` / `tool_attempt_detected`. Because that guarantee was verified per CLI version, only isolation-tested codex-cli versions run (currently `0.163`); others fail with `CODEX_ISOLATION_UNTESTED` unless `--auto-reply-allow-untested` is passed.
- The prompt uses only this session's transcript between the two peers and up to N excerpts from the tenant's confidential knowledge, read under the least-privilege role `peer_responder_reader` (never `connections/`).
- The reply goes back as `kind: reply` with `reply_to_message_id` and metadata `auto_generated` / `auto_turn`; retries reuse one message id, so the receiver deduplicates them. Generation and delivery failures are recorded separately in the ledger.

| Backend  | Reasoning provider (descriptor) | Isolation               | Version gate                  |
| -------- | ------------------------------- | ----------------------- | ----------------------------- |
| `claude` | `claude-agent`                  | `structural`            | none                          |
| `codex`  | `codex-cli`                     | `fail_closed_detection` | tested codex-cli `0.163` only |

`structural` means the transport exposes no tools to the model at all (a strictly isolated Claude query additionally discards any tool_use other than the SDK's structured-output tool). `fail_closed_detection` means tools stay visible but disabled and every observed tool attempt discards the reply. Any generator's tool attempt is recorded as `tool_attempt_detected`.

### Adding a generation backend

Backends are in-process code, never loaded from configuration, and a new one is usable only when all of these hold:

1. **Adapter** — implement `IsolatedTextGenerator` (`id`, `reasoningBackend`, `isolation`, `versionGated`, `describe()`, `generate()`) as a thin adapter over a provider-specific isolated query in `libs/core/provider/isolated-text-generator.ts`, and register it with `registerIsolatedTextGenerator`. The query must assert reasoning egress before any transport, run in an empty scratch working directory that is removed afterwards, pass an exact minimal environment (no `KYBERION_*` / `MISSION_*`, no peer secrets), honour the abort controller and `timeoutMs`, validate the schema, and throw an error whose `code` ends in `TOOL_ATTEMPT` on any tool attempt.
2. **Descriptor declaration** — add `"isolated_text_generation": { "isolation": "<structural|fail_closed_detection>" }` to the provider's `knowledge/product/governance/reasoning-providers/<mode>.json`. Resolution fails closed unless the declared level equals the generator's own `isolation`, so code alone cannot plug in a generator.
3. **Conformance suite** — call `describeIsolatedTextGeneratorConformance` (`libs/core/provider/__tests__/isolated-text-generator-conformance.ts`) with a harness that fakes the transport, as `isolated-text-generator.test.ts` does for `claude` and `codex`; the registry test asserts the registered generators equal the declared providers.
4. **Live isolation probe (CLI providers)** — run the real CLI with the isolation flags against prompts that ask for tool use, and record which tools the model sees and how attempts surface; detection must cover every observed signal.
5. **Tested-version gate (CLI providers)** — refuse CLI versions the probe has not verified (set `versionGated: true`); operators may override with `--auto-reply-allow-untested`.

Prerequisites, because the reply sends tenant-confidential material to an external provider:

1. Record a provider attestation for the tenant (`training_use: none`, human approval): `pnpm onboarding llm attest --tenant <tenant> --provider claude --training-use none ... --request-approval`, approve with `pnpm kyberion approvals --approve <id>`, then apply with the printed command. The reasoning gate allows the confidential `zero_retention` send only with this valid attestation, and only when the tenant's `allowed_reasoning_backends` (if set) and the provider declaration permit it.
2. Allow the provider's endpoint in the tenant egress policy (tenant domain grant for `api.anthropic.com`).

For `--auto-reply-backend codex` the same two gates apply to provider `codex`: attest with `--provider codex`, and grant the endpoint the codex-cli provider declaration names (`api.openai.com`) in the tenant egress overlay; if the tenant sets `allowed_reasoning_backends`, it must permit codex as well. The Codex CLI must already be logged in on that host (`codex login`).

Enabling a peer shares tenant knowledge excerpts with every holder of this server's shared secret, because the opt-in list is keyed by the authenticated `sender_peer_id`. Enable only peers you would show that knowledge to. Auto replies never run tools, change WorkItems, or touch missions; `handoff` messages keep the proposal-and-accept path.

## Typed peer tasks

A peer can ask another peer to _run_ something only through a typed peer task. The proposer names a task type; the recipient's own catalog decides what that type runs and who may ask for it. The proposal carries no parameters, so peer text never reaches an argv, a pipeline input or a prompt.

Recipient catalog — `knowledge/confidential/<tenant>/connections/peer-tasks.json` (read under the tenant-bound `peer_catalog_reader`; missing file = nothing offered):

```json
{
  "version": 1,
  "tasks": [
    {
      "task_type": "baseline.check",
      "description": "Run the baseline health check on this peer",
      "executor": { "kind": "pipeline", "pipeline": "pipelines/baseline-check.json" },
      "allowed_from_peers": ["kyberion-peer-b"],
      "timeout_ms": 600000,
      "share_output_excerpt": false
    },
    {
      "task_type": "test.peer-task-exchange",
      "description": "Run one fixed test file",
      "executor": {
        "kind": "pnpm_script",
        "script": "exec",
        "args": ["vitest", "run", "libs/core/mesh/peer-task-exchange.test.ts"]
      },
      "allowed_from_peers": ["kyberion-peer-b"]
    }
  ]
}
```

Flow (`pnpm kyberion peer task`, all commands take `--peer-id <this peer> --tenant-id <tenant>`):

1. **Propose** — `propose --to-peer <id> --task-type <type> --summary "<why>"` sends a `handoff` conversation message with `metadata.peer_task_request`. The recipient server records it and replies `pending local acceptance`. It refuses on receipt — without writing a ledger row — an unknown type, a peer not in `allowed_from_peers`, an expired proposal, a lifetime over 7 days or a request time in the future, and more than 20 pending tasks from one peer. Nothing runs on the receive path. If the proposal's reply was lost, `resend-proposal --task-id <id>` resends it with the same task and message id.
2. **Accept / reject** — the recipient operator runs `list --state pending`, then `accept --task-id <id> --actor-id <who> --reason "<why>"` (or `reject`). Acceptance creates a WorkItem (`source: peer`, `sourceRef: peer-task:<id>`, deterministic id), runs the catalog executor (`pnpm -s pipeline --input <pipeline>` or `pnpm -s <script> <args…>`) with the allowlisted exec environment, stores `report.json` and `output.log` under `active/shared/artifacts/confidential/<tenant>/report/peer-tasks/<task-id>/` (written by the tenant-bound `peer_task_artifact_writer`), and closes the WorkItem `done` (exit 0) or `blocked`.
3. **Result** — a `status` message with `metadata.peer_task_result` goes back to the proposer: status, exit code, the WorkItem id and artifact references (`ref`, `sha256`, `bytes`, `media_type`, `location: recipient_local`). The artifacts — including the full output — stay on the recipient; an output excerpt is sent only for catalog entries with `share_output_excerpt: true`. The result message id is stable, so `resend-result --task-id <id>` is idempotent; the proposer accepts a result only from the peer it asked.
4. **Recover** — an accepted task that stopped before recording its result (executor crash, artifact write failure) is re-run on the same WorkItem with `resume --task-id <id>`. Accept and resume are fenced per task and the running row records its runner (host, pid, deadline = start + `timeout_ms` + 1 min): `resume` is refused while that runner may still be executing (its process is alive, or its deadline has not passed — a killed parent can leave the executor child running), and `--force` takes over once the deadline has passed or, on the same host, once the runner process is gone. A task accepted after its expiry is answered with a `rejected` result; an unanswered outbound proposal reads as `expired` after its expiry.

**Sender identity.** The receiving server verifies every envelope with its own shared secret, so `sender_peer_id` — and with it `allowed_from_peers` — is asserted by any holder of that secret, not proven per sender. Give the server secret only to the peers you list, and treat `accept` as the human check: the operator confirms the proposer out of band before accepting anything with side effects.

Both sides keep the state in `active/shared/runtime/peer-messaging/tenants/<tenant>/peers/<local>/task-exchange.jsonl` (latest row per `<direction>:<task_id>`); `show --task-id` prints both directions and `offered` prints the local catalog. Auto replies never see or act on tasks: task messages are routed before the auto-reply worker, and `status` entries are excluded from reply history.

## Envelope rules

- Every message is HMAC-signed with the recipient server's shared secret (one secret per listening server; see Sender identity under Typed peer tasks).
- `tenant_id` is part of the signed envelope. The recipient rejects missing or mismatched tenant IDs, peer IDs, and invalid signatures.
- The peer catalog must declare the same tenant selected by the sender; a caller-supplied tenant never broadens access.
- Peer Messaging inbox/outbox JSONL files are durable audit records; they are not a deferred receiver queue. The HTTP success receipt includes processing_mode and processed_at after synchronous handling.
- Governed Mesh uses the separate tenant-scoped delivery ledger as its durable sender queue; its driver retries transport failures and the receiver deduplicates stable delivery message IDs.

## Tenant backup and restore

Tenant backup includes the tenant namespaces for peer messaging, conversations, and Mesh Hub runtime/observability. The archive itself is never sent as a peer payload. To notify another same-tenant peer, send only a signed `backup.artifact_reference` notification containing an encrypted artifact reference, SHA-256 hash, expiry, and `requires_explicit_acceptance: true`. The receiver accepts the reference locally and runs `pnpm backup restore --scope tenant --tenant <slug> ...`; restored peer/Mesh state is placed in `active/shared/runtime/peer-recovery-quarantine/` until re-enrollment and a fresh heartbeat are verified.

For an existing checkout that still has flat legacy records, first create a dry-run migration plan and then apply that exact plan after review:

```bash
pnpm peer:migrate-tenant-runtime
pnpm peer:migrate-tenant-runtime -- --plan active/shared/runtime/migrations/peer-tenant/manifests/<migration-id>.json --apply
```

Records without an explicit, valid tenant remain quarantined. After a tenant restore, request and resolve the human resume gate only after the peer has been re-enrolled and its heartbeat is healthy:

```bash
pnpm peer:runtime-recovery request --tenant-id <tenant> \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/<tenant>/<restore-id> \
  --requested-by <operator>
pnpm kyberion approve <approval-id> peer-recovery
pnpm peer:runtime-recovery resume --tenant-id <tenant> \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/<tenant>/<restore-id> \
  --approval-id <approval-id>
```
