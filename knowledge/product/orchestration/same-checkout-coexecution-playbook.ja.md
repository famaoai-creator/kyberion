---
title: 同一ディレクトリ複数CLI共存プレイブック
tags: [orchestration, multi-provider, co-session, co-execution, worktree, playbook]
last_updated: 2026-10-04
---

# 同一ディレクトリ複数CLI共存プレイブック

「同じディレクトリで複数のLLM CLIが立ち上がっている時」の1ページ版。矛盾したら正本が優先:

- [Multi-Provider Co-Execution Contract](../governance/multi-provider-coexecution-contract.md)
- [Agent Communication and Coordination Model](../architecture/agent-communication-layer-model.md)
- [Co-Session Coordination](../architecture/co-session-coordination.md)
- [Workspace Isolation](../architecture/workspace-isolation.md)

正本は [Same-Checkout Co-Execution Playbook](./same-checkout-coexecution-playbook.md)。本書は運用者向けの日本語 aids。

## 1. このディレクトリで動いているよ、を確認する

1. 起動時cwd契約: リポジトリrootか、mission中はmission worktree rootからのみ起動。サブディレクトリ起動は禁止。
2. 書く前に存在確認を挨拶化する:

```bash
pnpm exec tsx scripts/co_session.ts status --session-id <id>
pnpm kyberion workspace list --json
```

`status`は参加者・path lease・未ack handoffを返す。presenceはheartbeat方式 (`presence.jsonl`) で、切れたら解放可。`ps`列挙は正本にしない (pid再利用のため)。正本はworkspace ledgerの`pid + pidStartedAt`判定。

## 2. 同じと分かったら会話する

| 状況                               | 手段                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| 共有メモ・ゴール                   | `co-session blackboard` 追記/表示                                 |
| 特定インスタンスへの依頼           | `handoff create --to-participant-id <provider-pid>`               |
| プロバイダ種への放送               | `handoff create --to claude`                                      |
| 別Kyberion runtime (localhost含む) | Co-SessionではなくPeer Messaging + 明示accept                     |
| git・承認・顧客証跡が必要          | mission (`mission_controller`) に昇格、`promote-hint`で次手順確認 |

参加者は`provider + participant_id` (既定`{provider}-{pid}`) で区別。同一モデル複数起動は別ID。`promote-hint`は実行せず次コマンド表示のみ。

## 3. 同一ディレクトリ変更でコンフリクトしない

- Read: 全provider並行無制限。
- Write (repo file): work-item claim保持者のみ。mission無し暫定運用は短TTLの`lease acquire`を先に取る。leaseは協調用の目印であり認可・強制ではない。
- `.git`/repo config: mission ownerのみ。worker CLI・Co-Sessionからは触らない。
- Temp: 用途別固定配置のみ (`active/shared/tmp/`, `staging/`, `cache/`、成果物は`writeScopedArtifact`)。ad hoc禁止。
- Provider state (`.claude/`等): 手編集禁止、生成式で再現。
- Git index共有問題: `implementer`委譲はprivate `GIT_INDEX_FILE` (WS-01/02) で分離。誤`git add`は共有indexを汚さない。worker commitはdispose時reconcileで吸収。

権限の順序: `path lease (協調) < work-item claim (書込権限正本) < mission owner (.git)`。

## 4. 特別則: kyberion自体の開発は必ずworktree

originがkyberion本流でコードに触る変更は:

- 実作業はowner pathの`createSessionWorktree`で作った`.worktrees/<sessionId>` (budget・ledger登録済み) の中でのみ行う。`main`直書き禁止。
- workerは`worktree add/remove`しない。削除は`deleteRegisteredWorkspace`経由の`git worktree remove --force`のみ + clean-worktree check。`rm`禁止。
- 知識昇格も同root (`memory-promote --target-root <worktree>`) に寄せ、学びはコードと同じPRで出す。

理由: 共有index競合、worker commitによるHEAD巻き戻し、差分不可視を同時に消す。1 checkout 1 writerで履歴をレビュー可能にする。

## 5. 運用ループ (ポーリングは必須)

Co-Sessionにpushはない。presence・blackboard・handoffは読み直さない限り見えない。
`listCoSessionPresence`は5分無更新で足切りするので、放置CLIは消え、クラッシュCLIは残像になる。
コマンドの記載だけでは足りない。以下を回す:

1. 開始時: `join --as <provider> --note "<作業内容>"`
2. 5分以内ごとに: `heartbeat --as <provider>`
3. 書き込み前は毎回: `status` (lease確認) + `handoff list --pending-only`
4. 終了時: `leave --as <provider>` でlease解放

## 6. opencodeへの注入 (ウォッチャー)

opencodeセッションは外部メッセージを受け付ける (`opencode run --session <id> "<message>"`は
起動中バックグラウンドサービス上で次ターンとしてキューに入る。プログラム的には`opencode api`、
永続接続は`serve`/`acp`)。同一checkoutのウォッチャーが両者を橋渡しする:

- 起点: `--to opencode` (または`--to-participant-id <opencode-pid>`) 宛で未ackの`handoffs.jsonl`新規行
- 動作: `opencode run -s <対応session-id> "<subject + body>"`し、配送を別cursorファイルに記録。
  配送時に`ack`しない。ackはopencode側が処理してから
- 守り: 同一checkout内のみ (peer/Meshへの橋渡し禁止)、配送済みは重複注入しない (冪等cursor)、
  handoffからmission・承認を自動開始しない。transport受領は作業受諾ではない
