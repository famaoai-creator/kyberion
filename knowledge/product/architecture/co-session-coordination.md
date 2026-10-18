---
title: Co-Session Coordination (Same-Checkout, Mission-Optional)
category: Architecture
tags: [architecture, co-session, multi-provider, coordination, peer-messaging, work-coordination]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-18
---

# Co-Session Coordination

同一リポジトリ checkout 上で、複数のプロバイダ CLI（`claude` / `cursor` / `codex` / `agy` / `grok` など）が
**mission 無しでも**協調するための薄いレイヤ。

## 1. 目的と非目的

通信経路全体の選択基準は[Agent Communication and Coordination Model](./agent-communication-layer-model.md)を正本とする。本書はそのうち同一 checkout の provider CLI が共有する調整面を定める。localhost で起動した別 Kyberion runtime は Co-Session 参加者ではなく、Peer Messaging の peer として扱う。

### 目的

- 同じ cwd / repo root で並走する CLI が、共有ゴール・存在確認・書き込み排他・引き継ぎを共有できる。
- peer messaging / Mesh Hub / work-coordination と**語彙を揃え**、必要時に昇格できる。

### 非目的

- peer messaging の代替（対 Kyberion インスタンスの署名付き transport）ではない。
- mission lifecycle / `.git` 所有 / 顧客証跡の代替ではない。
- CLI ごとに peer listener を立てて「peer で協調したことにする」ことではない。

## 2. 層関係

```
[同一 checkout の CLI 群]
        │
        ▼
  co-session  (本ドキュメント)
  presence / path lease / blackboard / handoff
        │  他マシン・他 Kyberion が必要
        ▼
  peer messaging (+ Mesh Hub allowlisted kinds)
        │  git / 承認 / 顧客証跡が必要
        ▼
  mission + work-item claim + dispatch-workitems
```

| 層                | 単位                                  | 役割            |
| ----------------- | ------------------------------------- | --------------- |
| co-session        | 同一 checkout の参加者（provider id） | ローカル協調    |
| peer messaging    | Kyberion peer（HMAC・HTTP）           | transport       |
| work-coordination | WorkItem + item lease                 | 横断の作業実体  |
| mission           | mission owner + work-item claim       | 所有・証跡・git |

既存の整理（[`work-coordination-platform-plan.md`](../orchestration/work-coordination-platform-plan.md)）どおり:

> peer messaging は transport。協調にはその上の coordination layer が必要。

co-session はその coordination の **same-checkout 面**である。

## 3. 不変条件

[`multi-provider-coexecution-contract.md`](../governance/multi-provider-coexecution-contract.md) を継承する。

1. **読み取り**は全参加者並行可。
2. **mission-optional の書き込み調整**には path lease を使う（短 TTL、heartbeat 切れで解放可）。これは協調用の目印であり、認可や強制的な permission enforcement ではない。WorkItem claim が必要な作業では claim が書き込み権限の正本となる。**例外（実効化）**: hook 対応 CLI（Claude Code・Gemini CLI）では PreToolUse / BeforeTool hook が他 participant の active lease への書き込みを deny する。その CLI 内では lease は実効的な排他として働くが、store 読み取り不能時は fail-open で advisory に戻る。hook を持たない CLI では従来どおり advisory のみ。lease の read-check-write 自体は `withLockSync('co-session-lease:<session>:<path_hash>')` でプロセス間直列化される。
3. **`.git` / repo config** は co-session では触らない。commit が要る場合は mission owner へ昇格。
4. **一時ファイル**は `active/shared/tmp/` または session 配下のみ。
5. **peer / Mesh の禁止を継承**: co-session → peer の bridge は mission を作らない・承認しない（Mesh ADR）。

## 4. データ配置

```
active/shared/runtime/co-sessions/
  CURRENT                     # sticky: いまの session_id（任意）
  {session_id}/
    session.json              # goal, status, created_at, checkout_root
    presence.jsonl            # heartbeat
    blackboard.md             # 共有メモ
    leases/{path_hash}.json   # path 単位リース
    handoffs.jsonl            # 依頼・完了通知
active/shared/observability/co-sessions/
  {session_id}/events.jsonl   # 監査イベント
```

## 5. 語彙（Mesh / work-coordination と揃える）

Handoff / 依頼の `kind` は Mesh Hub の allowlist と同系:

- `review.request`
- `workitem.claim`（path lease 取得の意図記録にも可）
- `workitem.handoff`
- `workitem.status_update`
- `notification.publish`

ローカル専用の方言を増やさない。他 peer へ lift するときは同じ kind を peer envelope / `mesh-request` に載せる。

## 6. CLI 面

`pnpm exec tsx scripts/co_session.ts`（`co-session` コマンド）:

| 動詞                           | 意味                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `start`                        | goal 付きで session 開始（sticky CURRENT 更新）                                                |
| `join`                         | 既存 / sticky session に参加 + heartbeat                                                       |
| `leave`                        | 参加終了、自 lease 解放                                                                        |
| `heartbeat`                    | presence 更新                                                                                  |
| `status`                       | 参加者・lease・未 ack handoff                                                                  |
| `blackboard`                   | 表示 / 追記                                                                                    |
| `lease acquire\|release\|list` | path 排他                                                                                      |
| `handoff create\|list\|ack`    | 引き継ぎ。同一プロバイダ複数時は `--to-participant-id` / `--participant-id` でインスタンス指定 |
| `promote-hint`                 | peer / mission 昇格の次コマンドを表示（実行はしない）                                          |

同一モデルが複数並走する場合、参加者は `provider` + `participant_id`（既定 `{provider}-{pid}`）で区別する。path lease と handoff の宛先・ack は participant 単位。`--to claude` のみはプロバイダ種へのブロードキャスト、`--to-participant-id claude-b` は特定インスタンス宛て。

### 6.1 hook ブリッジ（対応 CLI への自動配線）

handoff の配送は pull（`handoff list`）が基本だが、hook を持つ CLI では session イベント駆動で join / heartbeat / drain / lease deny / release が自動で走る。コアは `libs/core/provider/co-session-hook.ts`（provider 非依存）で、CLI ごとの薄いエントリが入出力を変換する。

| CLI           | 配線                                                                                                                                                                            | イベント → 動作                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | tracked な `.claude/settings.json` が `dist/scripts/claude_code_hook.js` を直接呼ぶ（plugin 無しでも発火。plugin install 済みなら二重発火しうるが join/drain は重複許容で安全） | `SessionStart` join / `UserPromptSubmit` handoff drain 注入 / `PreToolUse` lease deny / `SessionEnd` 自 lease 解放    |
| Gemini CLI    | `pnpm generate:provider-hooks`（generation ceremony）が `.gemini/settings.json` を冪等生成し `dist/scripts/gemini_cli_hook.js` を指す                                           | `SessionStart` join / `BeforeAgent` drain 注入 / `BeforeTool` (`write_file`/`replace`) lease deny / `SessionEnd` 解放 |
| Codex CLI     | `pnpm generate:provider-hooks` が `.codex/hooks.json` を生成。CLI の `/hooks` で定義を確認・信頼する                                                                            | `SessionStart` join + drain / `UserPromptSubmit` と `PostToolUse` 新着 drain / `SessionEnd` 解放                      |
| agy / grok 等 | `scripts/co-session-monitor/poll.ts --provider <p> --participant-id <id>` で pull                                                                                               | —                                                                                                                     |

Codex の hook は開始済みの sticky Co-Session に参加する。Co-Session 自体の開始は operator が明示する。
セッション開始後に Co-Session が作られた場合も、次の入力・ツール完了時の heartbeat で参加する。
`.codex/hooks.json` は生成物であり、既存の利用者 hook は同じイベント内でも保持する。設定再生成は冪等。
Codex の対応仕様は [公式 Hooks ドキュメント](https://developers.openai.com/codex/hooks) を参照。
プロジェクトの trust と hook 定義の trust は CLI 側で管理され、生成処理は信頼設定を変更しない。

Codex の `PostToolUse` は作業中の受信点であり、待機中に新しいターンを起動しない。
新着は参加者別の `hook-deliveries/<participant-hash>.json` に通知済み ID を保存して重複を抑制する。
通知済みは ack と異なり、処理後の `handoff ack` は agent の明示操作のまま。同じ provider の別 CLI には個別に通知する。
通知は一回に最大10件、残りは次の受信点に回す。自分自身が発行した handoff は再注入しない。
この通知は best-effort（出力前にプロセスが落ちると再注入されない場合がある）なので、未 ack 一覧が正本である。
共有ファイル変更前の状態・lease 確認、競合・blocker・レビュー依頼・作業引き継ぎ時に明示 handoff を使う。
peer の文面は非信頼データとして扱い、通知・ack に機械的な返信をしない。

**停止 hook の再帰防止**: Claude の `Stop` は計測・監査のみで stdout に継続指示を出さない。
`stop_hook_active=true` は計測前に終了する。レビュー案内は入力時に行う。
Codex の生成設定には `Stop` を登録しない。`Stop` を直接呼んでも無処理で、`decision: block` を返さない。
lease 解放はターン末ではなく `SessionEnd` のみ。
Codex adapter は通知専用で lease による patch / shell 書き込みの強制拒否は行わない。

participant_id は `<provider>-<session_id>`（hook payload の `session_id`）。lease 取得コマンドは SessionStart 注入テキストに `--participant-id` 込みで提示される — hook 経由の CLI で `co-session lease acquire` を素のまま実行すると holder が `{provider}-{pid}` になり、lease gate の自己判定と一致しないため、注入どおりに引くこと。

制限: deny は file-write ツール（Write/Edit/MultiEdit、write_file/replace）にのみ効く。`Bash` / `run_shell_command` 経由の書き込みは hook の対象外で lease を迂回しうる — advisory の範囲であり、強い排他が要るなら work-item claim へ昇格する。deny 理由には保持者・期限・代替手段（lease list / handoff）を含める。

## 7. 昇格ゲート

同じ host にあるという理由だけで Co-Session と Peer Messaging を混同しない。同一 checkout を共有する provider CLI は Co-Session、別 Kyberion runtime は peer として扱う。別 runtime は peer ID、port、secret、runtime root / namespace を分離する。

| 状況                   | 行く先                                             |
| ---------------------- | -------------------------------------------------- |
| 同じ checkout 内の分業 | co-session のみ（mission-optional lease は協調用） |
| 別ホスト / 別 Kyberion | peer messaging + 明示 accept                       |
| git・承認・顧客証跡    | mission（`mission_controller`）                    |

## 8. 実装マップ

- Core: `libs/core/co-session.ts`（lease 直列化は `foundation/lock-utils.ts` の `withLockSync`）
- Hook bridge core: `libs/core/provider/co-session-hook.ts`
- Hook entries: `scripts/claude_code_hook.ts`（Claude: 同 `libs/core/provider/claude-code-hook.ts`）、`scripts/gemini_cli_hook.ts`（Gemini）、`scripts/codex_cli_hook.ts`（Codex）
- 配線: `.claude/settings.json`（tracked・直接配線）、`pnpm generate:provider-hooks` → `.gemini/settings.json` / `.codex/hooks.json`（gitignore・生成物）
- CLI: `scripts/co_session.ts`、`scripts/co-session-monitor/poll.ts`（`--provider`/`--participant-id` 汎用）
- 契約参照: 本ファイル + multi-provider coexecution + work-coordination platform + peer-network

## 9. 関連

- [`multi-provider-coexecution-contract.md`](../governance/multi-provider-coexecution-contract.md)
- [`workspace-isolation.md`](./workspace-isolation.md) — git の共有状態（index）をセッション単位に分離する private index / owner 専用 worktree / workspace ledger
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)
- [`peer-network.md`](../orchestration/peer-network.md)
- Mesh ADR: [`2026-06-24-mesh-hub-v1-boundaries.md`](./decisions/2026-06-24-mesh-hub-v1-boundaries.md)
