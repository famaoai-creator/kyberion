---
title: Work Coordination Platform
kind: orchestration
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [coordination, kanban, work-item, github, jira, peer, todo]
---

# Work Coordination Platform

複数の Kyberion が同じ作業を協調して進めるための実行基盤です。

Mission lifecycle の記録と連動させる場合は、[`mission-lifecycle-and-record-keeping.md`](../architecture/mission-lifecycle-and-record-keeping.md) を先に参照してください。

## What It Does

- `WorkItem` を共通の作業実体として扱う
- Board は `WorkItem` の view として扱う
- Peer messaging は coordination command の transport として使う
- GitHub Issue / Jira Issue を `WorkItem` に取り込む
- Mission 由来の NEXT_TASKS は `dispatch-tickets` で WorkItem と issue payload に展開する
- 個人 TODO / プロジェクトボード / peer queue / review queue を同じ実体から切り出す

Mission 型の作業では、`record-task` / `checkpoint` / `verify` / `distill` / `finish` によって board 外の mission state と board view を同期します。

## Processing Timing

- Peer 受信は `synchronous_on_receive`
- 受信 HTTP request の中で署名検証と command 実行を終える
- ACK は command 処理後に返す
- Deferred worker は未導入

## CLI

Use `pnpm work:coord --help` for the full command surface.

Common commands:

- `create-item`
- `create-board`
- `list-board`
- `claim-item`
- `release-item`
- `handoff-item`
- `renew-lease`
- `update-status`
- `record-event`
- `import-github-issue-file`
- `import-jira-issue-file`

Import commands are catalog-driven from [`knowledge/product/governance/work-coordination-import-catalog.json`](../governance/work-coordination-import-catalog.json). Additions should go through the catalog instead of hardcoding new command bindings in the CLI.

Mission-specific registration is separate from external import:

- `dispatch-tickets` registers a mission's planned tasks as durable `WorkItem` records.
- The same pass can emit mission-local GitHub / Jira issue payload artifacts for review or later live creation.
- Live GitHub / Jira creation remains an optional follow-up action and does not replace local board state.
- `dispatch-workitems` executes registered `WorkItem`s and writes the response back into:
  - mission evidence
  - `coordination/tickets/replies/**`
  - `coordination/tickets/dispatch-manifest.json`
  - `NEXT_TASKS.json` ticket annotations
  - mission-local GitHub / Jira issue payload artifacts
- When the ticket is linked to live GitHub / Jira targets, the result is also appended as a comment and the issue state is advanced when possible.

## Board Types

- `project`: project / track に紐づく board
- `personal`: 個人 TODO board
- `peer`: Kyberion peer の作業キュー
- `review`: レビュー待ちの横断 board
- `external`: GitHub / Jira 同期 view

## External Imports

### GitHub

`import-github-issue-file` で GitHub Issue JSON を読み込みます。

Mapping:

- `issue.number` / `issue.id` -> `source_ref`
- `title` -> `title`
- `body` -> `description` fallback
- `state=closed` -> `done`
- `state=open` + assignee あり -> `ready`
- `state=open` + assignee なし -> `backlog`

### Jira

`import-jira-issue-file` で Jira Issue JSON を読み込みます。

Mapping:

- `fields.summary` -> `title`
- `fields.description` -> `description`
- `fields.status.name` -> normalized status
- `fields.priority.name` -> normalized priority
- `fields.assignee.accountId` -> `assignee_user_id`

Unknown Jira status values are imported as `backlog` and emit a warning event.

## Examples

- [Project board example](./work-coordination-examples/project-board.json)
- [Personal TODO example](./work-coordination-examples/personal-todo.json)
