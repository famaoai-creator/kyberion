---
title: Work Coordination Platform Implementation Plan
kind: orchestration
scope: repository
authority: proposal
phase: [alignment, execution, review]
tags: [coordination, kanban, work-item, github, jira, peer, todo]
---

# Work Coordination Platform Implementation Plan

この文書は、複数の Kyberion が協調して作業を進め、GitHub Issues / Jira などの外部チケットとも連携できる作業基盤を実装するための計画です。

想定実装者は `gpt-5.4-mini` です。各ステップは、小さく実装してテストできる粒度に分けます。

## Concept Review

元のアイデアは妥当です。現在の peer messaging は Kyberion 間で署名付きメッセージを交換する transport であり、協調して作業を前に進めるには、その上に作業状態を持つ coordination layer が必要です。

ブラッシュアップした結論は以下です。

- 主役は Kanban board ではなく `WorkItem` にする。
- Board は `WorkItem` の view として扱う。
- GitHub Issue / Jira Issue / personal TODO はすべて `ExternalSource` または `LocalSource` として `WorkItem` に投影する。
- Kyberion 間の peer message は board 操作そのものではなく、`claim`, `handoff`, `status_update`, `review_request` などの coordination command を運ぶ。
- 同じ `WorkItem` は、プロジェクトボード、人別 TODO、レビュー待ちボードなど複数 board に同時に表示できる。
- 同時作業は `lease` と `version` で制御する。

## Non-Goals

- 初期実装では GitHub / Jira への完全双方向同期をしない。
- 外部チケットを Kyberion 内で丸ごとコピーして別実体にしない。
- 受信 peer message を無条件に mission 実行へ直結しない。
- Board UI を先に作らない。まず schema、store、commands、tests を固める。

## Core Model

### WorkItem

共通の作業実体です。

必須フィールド:

- `item_id`: Kyberion 内部 ID
- `title`
- `description`
- `status`: `backlog`, `ready`, `in_progress`, `blocked`, `review`, `done`, `archived`
- `priority`: `low`, `normal`, `high`, `urgent`
- `source`: `local`, `github`, `jira`, `peer`
- `source_ref`: 外部 ID または local ref
- `project_id`
- `assignee_peer_id`
- `assignee_user_id`
- `labels`
- `dependencies`
- `version`
- `created_at`
- `updated_at`

### Board

`WorkItem` をどう見るかを定義する view です。

Board type:

- `project`: project / track ごとの作業ボード
- `personal`: 個人 TODO
- `peer`: Kyberion peer ごとの作業キュー
- `review`: レビュー待ち横断ビュー
- `external`: GitHub / Jira 由来の同期ビュー

Board は item を所有しません。`filter`, `sort`, `lanes` によって `WorkItem` を表示します。

### Lease

同時作業を避けるための一時的な作業権です。

必須フィールド:

- `lease_id`
- `item_id`
- `holder_peer_id`
- `holder_user_id`
- `purpose`: `implementation`, `review`, `triage`, `sync`
- `expires_at`
- `created_at`
- `renewed_at`

期限切れ lease は他 peer が再取得できます。更新時は `version` を見て競合を検出します。

### CoordinationEvent

監査可能な履歴です。

event type:

- `item_imported`
- `item_created`
- `item_updated`
- `item_claimed`
- `item_released`
- `item_handed_off`
- `item_blocked`
- `item_unblocked`
- `review_requested`
- `external_sync_pulled`
- `external_sync_pushed`
- `conflict_detected`

## Processing Timing

Peer message の transport は既存どおり `synchronous_on_receive` です。つまり、受信 peer は HTTP request の中で署名検証と responder 処理を終えてから ACK を返します。

Coordination layer では、受信時に実行する処理を次の 2 種類に分けます。

- Immediate: schema validation, signature verification, idempotency check, event append, command acceptance.
- Deferred: external sync, mission execution, long-running review, artifact generation.

初期実装では deferred worker は作りません。長時間処理が必要な command は、受信時に `accepted` event を残し、後続の mission / pipeline へ明示的に渡す設計にします。

## External Integration Policy

### GitHub Issues

最初の adapter 対象です。理由は repository context と Issue / PR workflow が Kyberion の既存用途に近いためです。

初期 pull mapping:

- GitHub `issue.number` -> `source_ref`
- `title` -> `title`
- `body` -> `description`
- `state` -> `status`
- `labels` -> `labels`
- `assignees` -> `assignee_user_id`
- `updated_at` -> external cursor

初期 push mapping:

- Kyberion comment event -> GitHub issue comment
- Kyberion label delta -> GitHub labels
- Kyberion done transition -> optional close, gated by explicit flag

### Jira

GitHub adapter の後に実装します。

初期 pull mapping:

- Jira `key` -> `source_ref`
- `summary` -> `title`
- `description` -> `description`
- `status.name` -> `status`
- `priority.name` -> `priority`
- `assignee.accountId` -> `assignee_user_id`

初期 push mapping:

- Kyberion comment event -> Jira comment
- Kyberion status transition -> Jira transition, gated by configured transition map

### Conflict Rule

外部 system と Kyberion の両方で更新があった場合は自動上書きしません。

Default source of truth:

- Title / description: external system
- Board membership / lease / peer assignment: Kyberion
- Comments: append-only merge
- Status: adapter policy decides, default is conflict event

## Storage Layout

初期実装では local JSONL / JSON store で十分です。

Files:

- `active/shared/runtime/work-coordination/items.jsonl`
- `active/shared/runtime/work-coordination/boards.json`
- `active/shared/runtime/work-coordination/leases.jsonl`
- `active/shared/observability/work-coordination/events.jsonl`

Schemas:

- `knowledge/public/schemas/work-item.schema.json`
- `knowledge/public/schemas/work-board.schema.json`
- `knowledge/public/schemas/work-lease.schema.json`
- `knowledge/public/schemas/work-coordination-event.schema.json`

Core implementation:

- `libs/core/work-coordination.ts`
- `libs/core/work-coordination.test.ts`

CLI:

- `scripts/work_coordination.ts`

## Command Surface

Initial commands:

- `create-item`
- `import-github-issue`
- `list-board`
- `claim-item`
- `release-item`
- `handoff-item`
- `update-status`
- `record-event`

Future commands:

- `sync-github`
- `sync-jira`
- `push-external-update`
- `expire-leases`
- `route-peer-command`

## Peer Message Types

Add coordination payloads over existing peer messaging:

- `coordination.claim_request`
- `coordination.claim_result`
- `coordination.handoff_request`
- `coordination.status_update`
- `coordination.review_request`
- `coordination.external_sync_notice`

Each message must include:

- `command_id`
- `item_id`
- `expected_version`
- `actor_peer_id`
- `idempotency_key`
- `requested_at`

## Implementation Plan for gpt-5.4-mini

### Step 1: Define Schemas

Goal:

Create schemas for `WorkItem`, `Board`, `Lease`, and `CoordinationEvent`.

Files:

- `knowledge/public/schemas/work-item.schema.json`
- `knowledge/public/schemas/work-board.schema.json`
- `knowledge/public/schemas/work-lease.schema.json`
- `knowledge/public/schemas/work-coordination-event.schema.json`

Acceptance:

- Schemas parse as JSON.
- Required fields match this plan.
- `pnpm run check:catalogs` passes.

### Step 2: Implement Local Store

Goal:

Add local append-only storage APIs.

Files:

- `libs/core/work-coordination.ts`
- `libs/core/work-coordination.test.ts`
- `libs/core/index.ts`

Required APIs:

- `createWorkItem(input)`
- `listWorkItems(filter)`
- `createBoard(input)`
- `listBoardItems(boardId)`
- `appendCoordinationEvent(event)`
- `listCoordinationEvents(filter)`

Acceptance:

- Unit tests cover create/list/event append.
- No direct `node:fs`; use existing secure IO helpers.

### Step 3: Add Lease and Version Control

Goal:

Prevent duplicate work across peers.

Required APIs:

- `claimWorkItem(itemId, actor, purpose, ttlMs, expectedVersion)`
- `releaseWorkItem(itemId, actor, leaseId)`
- `renewWorkItemLease(leaseId, ttlMs)`
- `expireWorkItemLeases(now)`

Acceptance:

- Claim succeeds when no active lease exists.
- Claim fails when an active lease exists.
- Expired lease allows reclaim.
- Stale `expectedVersion` fails with `version_conflict`.

### Step 4: Add Board Views

Goal:

Support multiple boards over the same items.

Required board examples:

- `project-default`
- `personal-todo`
- `peer-queue`
- `review-waiting`

Acceptance:

- Same item can appear on multiple boards.
- Board membership is derived from filters, not item duplication.
- Tests cover project board and personal TODO board.

### Step 5: Add Peer Coordination Commands

Goal:

Map peer messages into coordination commands.

Files:

- `libs/core/work-coordination-peer.ts`
- `libs/core/work-coordination-peer.test.ts`

Required behavior:

- Validate command payload.
- Check `idempotency_key`.
- Apply local coordination command.
- Append `CoordinationEvent`.
- Return explicit result with `processing_mode`.

Acceptance:

- `claim_request` over peer messaging creates a lease.
- Duplicate command is idempotent.
- Invalid version returns conflict without mutating item.

### Step 6: Add GitHub Issue Adapter

Goal:

Import GitHub Issues into `WorkItem`.

Files:

- `libs/core/work-integrations/github-issues.ts`
- `libs/core/work-integrations/github-issues.test.ts`

Initial scope:

- Accept plain GitHub issue payload objects in tests.
- Map payload to `WorkItem`.
- Do not require live GitHub API in unit tests.

Acceptance:

- Open issue maps to `ready` or `backlog`.
- Closed issue maps to `done`.
- Labels and assignees are preserved.
- Existing `source_ref` updates item instead of creating duplicate.

### Step 7: Add Jira Adapter

Goal:

Import Jira issues into `WorkItem`.

Files:

- `libs/core/work-integrations/jira-issues.ts`
- `libs/core/work-integrations/jira-issues.test.ts`

Acceptance:

- Jira key maps to `source_ref`.
- Status and priority are normalized.
- Unknown statuses produce `backlog` plus a warning event.

### Step 8: Add CLI

Goal:

Give operators a usable path before UI work.

File:

- `scripts/work_coordination.ts`

Commands:

- `create-item`
- `list-board`
- `claim-item`
- `release-item`
- `handoff-item`
- `import-github-issue-file`
- `import-jira-issue-file`

Acceptance:

- Commands print JSON by default.
- Failures include actionable error messages.
- Tests or smoke scripts cover at least create/list/claim.

### Step 9: Add Documentation and Examples

Goal:

Document the operator path.

Files:

- `knowledge/public/orchestration/work-coordination-platform.md`
- `knowledge/public/orchestration/work-coordination-examples/project-board.json`
- `knowledge/public/orchestration/work-coordination-examples/personal-todo.json`

Acceptance:

- Same-host Kyberion coordination example is documented.
- GitHub import example is documented.
- Personal TODO board example is documented.

## Suggested Milestones

Milestone 1:

- Schemas
- Local store
- Lease/version control
- Basic tests

Milestone 2:

- Board views
- CLI create/list/claim/release
- Project and personal boards

Milestone 3:

- Peer coordination commands
- Same-host coordination smoke

Milestone 4:

- GitHub Issue adapter
- Jira adapter
- External sync event model

## Validation Commands

Run after each milestone:

```bash
pnpm exec vitest run libs/core/work-coordination.test.ts
pnpm run check:catalogs
pnpm build
```

After peer command integration:

```bash
pnpm exec vitest run libs/core/peer-messaging.test.ts libs/core/work-coordination-peer.test.ts
```

## Open Decisions

- Whether `WorkItem` belongs under `libs/core` permanently or should become an actuator later.
- Whether GitHub/Jira push operations should be allowed by default or require explicit approval.
- Whether personal TODO boards should live in `knowledge/personal` once user-specific data is introduced.
- Whether long-running deferred coordination should use mission controller directly or a separate worker loop.

## Recommended First Implementation

Start with Milestone 1 and Milestone 2 only. That creates a useful local coordination kernel without depending on external APIs or UI. Once local boards and leases are stable, connect peer messages. GitHub and Jira should come after the internal model can already represent project boards and personal TODO lists.
