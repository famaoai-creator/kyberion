---
title: Agent collaboration view plan
tags: [terminal-hud, collaboration, observability, surface, 2026-09]
last_updated: 2026-09-06
status: active
---

# エージェント連携ビュー計画(AC-01〜07)

> **位置づけ**: ターミナル主体で kyberion を使うときの「各エージェントが連携して動く様を把握する」入口を、`pnpm tui`(terminal-hud)に追加する。
> **ミッション**: `MSN-AGENT-COLLAB-VIEW-20260906`(public tier)。ブランチ `agent/agent-collab-view-20260906`(SX ブランチ `agent/sx-simplicity-20260825` = PR #711 の HEAD `751d156eb` から分岐。SX が terminal-hud を 34 ファイル変更しているため main 起点にしない)。実装は worktree `/Volumes/data/forcheck/kyberion-agent-collab` で行う(同一 checkout を別エージェントが並行編集しているため)。
> **実装状況の索引**: [2026-08 README](./README.ja.md)。

## 0. 要旨

利用者の要望は「hedr のように、各エージェントが連携して動作していく様を把握できる形」。2026-09-06 の read-only 監査の結論は次のとおり。

- **正規化イベントストリームは既にある。** `libs/core/worker-event-stream.ts` が `subagent_begin/end/unavailable`・`approval_request/response`・`mission_event`・`phase_*`・`gate_evaluated` を単一 envelope(`type, ts, seq, source{mission_id,task_id,agent_id,...}, payload`)で `active/shared/logs/worker-events/` に日次 JSONL 記録している。
- **グラフ投影も既にある。** `libs/core/agent-collaboration-projection.ts` が worker-events + `observability/mission-control/{task,orchestration,agent-runtime-supervisor}-events.jsonl` を `nodes / edges / overview / attention` に合成し、Chronos(`AgentCollaborationBoard`)と terminal-hud(パネル 5)の両方が読んでいる。
- **したがって新しいイベント源も新しい投影も作らない。** 欠けているのは次の 4 点であり、本計画はその 4 点だけを埋める。

| #   | ギャップ                                | 事実(2026-09-06 実測)                                                                                                                                                                                                                                                            |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 委譲イベントに相関鍵がない              | 記録済み `subagent_begin` は `{dispatcher, profile}` のみ。`subagent_end` と対応付ける ID も、`source.mission_id` も、親 agent もない(`libs/core/agent-dispatch.ts:399-415`、`worker-events-2026-08-15.jsonl` 実サンプル)                                                        |
| G2  | agent→agent エッジが redaction で落ちる | `a2a-bridge.ts:422-435` は `sender / receiver / performative / intent` を emit するが、`agent-collaboration-events.ts` の `SHARED_METADATA_KEYS` に含まれないため disk に残らない。投影のエッジは `mission→task`・`task→agent` のみ(`agent-collaboration-projection.ts:520-533`) |
| G3  | 投影の読み込みが無制限                  | `readJsonl` は byte 上限なしの全読み。`agent-runtime-supervisor-events.jsonl` は 29MB / 26.6 万行、worker-events は 7.9MB(step イベント 4.4 万件)。HUD パネル 5 はこれを 10 秒ごとに同期実行している                                                                             |
| G4  | HUD の表示が薄い                        | パネル 5 は `attention.slice(0,5)` を文字列化した 5 行 + overview 1 行のみ。ツリーも drill-down もなく、監視パスに worker-events / mission-control が入っていないので更新は interval 頼み。Chronos の board も統計 + 注意項目のリストでグラフは描いていない                      |

補足: `agent-runtime-events.jsonl`(`MISSION_PAUSED` 等、キーが `event`)はどの投影にも読まれていない孤児データ。`observability/peer-conversations/**/events.jsonl` も未消費。投影の `attention` の title/next_action と `agent-activity-board.ts` の blocker 文言は日本語のハードコードで、HUD の `L` ロケール切替に追従しない。

## 1. 設計判断

1. **表示は「木」+「待ち関係」に絞る。** hedr 的に価値があるのは「誰が何をしていて、誰を待っているか」を一目で見ることであり、任意グラフのレイアウトではない。`mission → task → agent → child agent` の木と、各ノードの `waiting_on`(承認待ち / 子の完了待ち / クレーム待ち / ブロック)を正とする。agent→agent の a2a エッジは木の中で「→ receiver」注記として出す。
2. **木の合成は `libs/core` の純関数。** `composeCollaborationTree(projection, activityBoard?)` を新設し、HUD と Chronos が同じ関数から描画する。surface 側はレイアウト(行への変換)だけを持つ。
3. **文言はコードで返し surface が翻訳する。** 木・注意項目には `reason_code`(閉じた列挙)を追加し、HUD は `user-facing-vocabulary.json` の `tui:` キーで描く。既存の日本語文字列フィールドは互換のため残す(削除は別起票)。
4. **読み込みは有界が既定。** 投影に `bounded` オプション(ファイルあたり byte 上限 + 直近 N 日)を追加し、既定を有界にする。step_begin/step_end は木には不要なので既定で除外する(overview の `events` 数には影響するため、既存テストの期待値を確認して更新する)。
5. **パネルは新設(9 番)。** パネル 5 は runtime の起動/停止という操作面なので残し、連携ビューは read-only の 9 番に置く。cockpit の先頭に「待ち」の 1 行要約を足す。
6. **Claude ネイティブ subagent も同じ経路。** `HarnessSubagentDispatcher` が emit する `subagent_*` を直すことで、`claude-agent` / `codex` のネイティブ委譲もツリーに乗る(CN-03 の射影は変更不要)。ただし Claude Code 側が kyberion を経由せず起こした Agent ツール呼び出しは依然として映らない。これは可視化ではなく運用(ミッション経由で流す)の問題であり、本計画のスコープ外。

## 2. 項目

### AC-01: 委譲イベントの相関付け(G1)

`libs/core/agent-dispatch.ts` の `HarnessSubagentDispatcher` と `ProcessSpawnDispatcher` が emit する `subagent_begin / subagent_end / subagent_unavailable` に次を付ける。

- payload: `delegation_id`(begin で採番し end/unavailable に同じ値)、`parent_agent_id`(delegation chain 末尾 actor、無ければ `requested_by` 相当、無ければ省略)、`agent_id`(子の識別子。native の `thread_id` があればそれ、なければ `${profile}:${delegation_id 先頭 8 桁}`)、`team_role`(= profile)、`provider`、`instruction_summary`(先頭 120 文字、`redactCollaborationSummary` 経由)、`elapsed_ms`(end のみ)。
- source: `mission_id / task_id` を ambient(delegation chain・現在の mission focus・`options.context`)から埋める。
- `SHARED_METADATA_KEYS` に `delegation_id`、`instruction_summary`、`elapsed_ms`、`parent_agent_id`(既存確認)を追加(AC-02 と同一ファイルのため AC-02 担当が追加し、AC-01 はそれを前提にテストを書く)。

受入: `agent-dispatch.test.ts` で begin/end が同じ `delegation_id` を持ち、`source.mission_id` が伝播することを固定。`event-vocabulary.ts` の分類表は既存の `subagent_*` を使うので変更不要。

### AC-02: agent→agent エッジと親子エッジ(G2)

- `agent-collaboration-events.ts`: `SHARED_METADATA_KEYS` に `sender`、`receiver`、`performative`、`intent`、`delegation_id`、`instruction_summary`、`elapsed_ms` を追加。`prompt_excerpt` と `thread` は追加しない(本文断片は disk に残さない)。
- `agent-collaboration-projection.ts`: (a) `a2a_message_routed` から `agent:sender → agent:receiver` エッジ(kind `handoff`)、(b) `subagent_begin` から `agent:parent → agent:child` エッジ(kind `spawn`)を生成。`AgentCollaborationEvent` に `parent_agent_id` は既にあるので `receiver` / `delegation_id` を追加。
- `readSourceEvents` に `agent-runtime-events.jsonl`(キー `event`)を加え、`event_type` に写像する。`event-vocabulary.ts` の `INFERENCE_RULES` で `MISSION_*` を `progress / blocked / failure` に分類。

受入: 投影テストで a2a 1 件 + subagent 1 組から 2 エッジが出ること、既存エッジのスナップショットが壊れないこと。

### AC-03: 有界読み込み(G3)

- `ComposeCollaborationProjectionOptions` に `bounded?: { maxBytesPerFile?: number; recentDays?: number; includeStepEvents?: boolean }` を追加。既定 `{ maxBytesPerFile: 2MiB, recentDays: 2, includeStepEvents: false }`。`bounded: false` で従来の全読み。
- 実装は `libs/core/jsonl-tail.ts` の既存 helper(`createJsonlTail` / `splitCompleteLines`)を再利用し、ファイル末尾から byte 上限で読む。日付付きファイル(`worker-events-YYYY-MM-DD.jsonl`)は `recentDays` でファイル選別。
- `buildAgentCollaborationProjection` の既存呼び出し元(HUD、Chronos `api/collaboration`、`headless-projections`、`vital_check`)は既定の有界で動く。全読みが必要な箇所があれば明示的に `bounded: false` を渡す(監査対象: `vital_check.ts`)。

受入: 29MB の supervisor ファイルを与えても読み込みが 2MiB 分で止まるテスト(fixture で生成)。`partial: true` と `status_flags` に `bounded_read` を追加して「切り詰めた」ことを利用者に見せる。

### AC-04: 連携ツリーの合成(純関数)

新規 `libs/core/agent-collaboration-tree.ts`:

```ts
export type CollaborationWaitReason =
  'approval_pending' | 'child_running' | 'claim_pending' | 'blocked' | 'review_pending' | 'stale';
export interface CollaborationTreeNode {
  id: string; // projection の node id と同じ
  type: 'mission' | 'task' | 'agent';
  label: string;
  state?: string; // 最新 state_after / status
  provider?: string;
  team_role?: string;
  native?: boolean;
  started_at?: string;
  last_event_at?: string;
  elapsed_ms?: number;
  waiting_on: Array<{ reason: CollaborationWaitReason; target_id?: string; since: string }>;
  handoffs: Array<{ to_agent_id: string; performative?: string; at: string }>;
  children: CollaborationTreeNode[];
}
export interface CollaborationTree {
  generated_at: string;
  roots: CollaborationTreeNode[];
  waiting: Array<{
    node_id: string;
    reason: CollaborationWaitReason;
    since: string;
    reason_code: string;
  }>;
  stats: { agents_running: number; agents_waiting: number; humans_waited_on: number };
}
export function composeCollaborationTree(
  projection: AgentCollaborationProjection,
  opts?: { now?: string; staleAfterMs?: number; activityBoard?: AgentActivityBoard }
): CollaborationTree;
```

- 親子は `spawn` エッジ(AC-02)、所属は `mission→task→agent` エッジ、`waiting_on` は「`approval_request` に対応する `approval_response` が無い」「`subagent_begin` に対応する `subagent_end` が無い」「WorkItem が `blocked` / `review`」「最終イベントが `staleAfterMs` より古い」から導出。
- 投影の `attention` にも `reason_code` を additive に追加し、HUD が翻訳できるようにする(日本語 title は残す)。
- `index-part-09.ts` に export、`libs/core/package.json` の `exports` に `./agent-collaboration-tree` を追加。

受入: 純関数テスト(fixture の projection → 木)。deterministic な並び(mission id → task id → started_at)。

### AC-05: terminal-hud パネル 9「連携」(G4)

- `store/agent-graph.ts`: `loadAgentGraph()`(`buildAgentCollaborationProjection({limit: 200})` + `buildAgentActivityBoard()` → `composeCollaborationTree`)、`agentGraphWatchPaths()`(`logs/worker-events`、`observability/mission-control`、`runtime/work-coordination`。順序固定)、`agentGraphViewModel(data, i18n)`。
- 行 = 木の前順走査(インデントで階層)。列: `node`、`state`、`waiting`、`elapsed`、`provider/role`。`waiting` 行は色付け(`theme`)。上部 section に「いま待っているもの」を最大 5 行。
- `Enter` の detail: そのノードの直近イベント 10 件(`projection.events` から `agent_id` / `mission_id` で絞る)、a2a handoff の一覧、peer conversation があれば `listPeerConversationSessions` から最新 transcript 末尾 5 件。
- 配線: `keymap.ts`(`PANELS` に `agents`、`PANEL_LABEL_KEYS`、`GLOBAL_HELP` の `1-8`→`1-9`)、`app.tsx`、`snapshot.ts`(`SNAPSHOT_LOADERS`)、`user-facing-vocabulary.json`(`tui_tab_agents`、列・待ち理由・section 見出しを en/ja/qps-ploc)→ `pnpm generate:vocabulary-types`。
- cockpit(`store/operator-home.ts`)の先頭に `stats.agents_waiting` / `humans_waited_on` の 1 行を追加。
- テスト: `view-models.test.ts`(純関数)、`snapshot.test.ts`(8→9)、`keymap.test.ts`(digit/cycle)。
- `README.md` のパネル表を 9 行に更新し、`pnpm tui:once` / `tui:dev` の記述を実在する `pnpm tui --once` / `pnpm tui --dev` に直す(script 追加は SX-05 の package scripts ラチェット 120 に当たるため行わない)。

受入: `pnpm tui --once --panel agents` が木を出す。`pnpm test -- --suite tui` green。

### AC-06: Chronos の同一ツリー描画(P2)

- `api/collaboration/route.ts` の応答に `tree`(`composeCollaborationTree`)を additive に追加。
- `AgentCollaborationBoard.tsx` に折りたたみ可能なツリー section を追加(既存の統計・注意項目は維持)。文言は `chronos_ac_*` キー。

受入: `tests/chronos-ux-vocabulary-contract.test.ts` green。既存 SSE 経路は変更しない。

### AC-07: 文書

- `docs/SURFACES.md` の `pnpm tui` 行に「連携ビュー(パネル 9)」を追記。`docs/COMPONENT_MAP.md` に `agent-collaboration-tree.ts`。
- `knowledge/product/architecture/` に短い `agent-collaboration-view.md`(データ源 → 投影 → 木 → surface の流れ、G1〜G4 の解消状況、「ミッション経由でないと映らない」運用ルール)。frontmatter 付き。
- 本計画の「実装状況」節と README 索引の更新。

## 3. Wave 計画

| Wave | 項目          | 担当モデル | ファイル所有権                                                                                                                                                     | ゲート                                                                  |
| ---- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 0    | AC-01         | sonnet     | `libs/core/agent-dispatch.ts`, `agent-dispatch.test.ts`                                                                                                            | `vitest libs/core/agent-dispatch*`                                      |
| 0    | AC-02 + AC-03 | sonnet     | `libs/core/agent-collaboration-events.ts`, `agent-collaboration-projection.ts`, `event-vocabulary.ts`, それぞれの test                                             | `vitest libs/core/agent-collaboration* event-vocabulary*`               |
| 1    | AC-04         | opus       | `libs/core/agent-collaboration-tree.ts` + test, `index-part-09.ts`, `libs/core/package.json`                                                                       | `tests/core-runtime-import-contract.test.ts`, `check_module_boundaries` |
| 2    | AC-05         | sonnet     | `presence/displays/terminal-hud/**`, `user-facing-vocabulary.json`(`tui` domain のみ), `vocabulary-keys.generated.ts`(生成), (root `package.json` は触らない)      | `pnpm test -- --suite tui`, `check:vocabulary-types`                    |
| 2    | AC-06         | sonnet     | `presence/displays/chronos-mirror-v2/src/app/api/collaboration/**`, `components/AgentCollaborationBoard.tsx`, `user-facing-vocabulary.json`(`chronos` domain のみ) | `tests/chronos-ux-vocabulary-contract.test.ts`                          |
| 3    | AC-07         | haiku      | docs / knowledge                                                                                                                                                   | `check_improvement_plan_metadata`, link checker                         |

Wave ごとに orchestrator(Fable)が diff をレビューし、typecheck + 該当 suite + boundary 系テストを通してからタスク単位でコミットする。`user-facing-vocabulary.json` は Wave 2 の 2 エージェントが別 domain を編集するため、コミット順を AC-05 → AC-06 に固定し、AC-06 は着手前に再読込する。

## 4. 検証

- `pnpm typecheck`、`pnpm test -- --suite core`(該当ファイル)、`--suite tui`、`tests/core-runtime-import-contract.test.ts`、`tests/package-boundary-contract.test.ts`、`scripts/check_module_boundaries.ts`、`pnpm check:vocabulary-types`。
- 実物確認: 本ミッションで subagent を dispatch した後に `pnpm tui --once --panel agents` を実行し、`MSN-AGENT-COLLAB-VIEW-20260906` の木に子エージェントと `elapsed` が出ることを evidence に残す。

## 5. スコープ外(別起票)

> 2026-09-06 追記: 利用者の指示により、下記のうち **secure-io の tail read / 日本語ハードコードの撤去 / supervisor ログのローテーション / peer transcript 表示** の 4 件は本計画の第 2 期(§7 AC-08〜11)として同ブランチで実装する。残りは引き続き別起票。

- 投影 `attention` / activity-board の日本語ハードコード撤去(reason_code への完全移行)。
- `secure-io` への tail/range read primitive の追加(現状は全量読み後に末尾を切る)。
- HUD / Chronos が空になる条件の明示: 既定窓(HUD/Chronos 7 日、投影既定 2 日)内に dispatch 経由の活動が無いと「待ちはありません」だけになる。窓を UI から切り替える手段は未提供。
- `agent-runtime-supervisor-events.jsonl` のローテーション(29MB 放置の根治)。
- peer-conversations を投影のエッジ源に加えること。AC-05 の detail での transcript 表示も、`agent_id → peer_id` の対応表が無いため未実装(対応表の導入とセットで別起票)。
- 月次計画ディレクトリ `improvement-plans-2026-09` の新設(checker 4 本に 2026-08 が固定されているため、本計画は 2026-08 索引に置く)。

## 7. 第 2 期: follow-up(AC-08〜11)

### AC-08: secure-io の tail read primitive(G3 の根治)

- `libs/core/secure-io.ts` に `safeReadFileTail(filePath, maxBytes): { buffer: Buffer; truncated: boolean; size: number }` を追加。`fs.openSync` + `fs.readSync`(position 指定)で末尾 `maxBytes` だけ読む。既存の `safeReadFile` と同じ path 検証・authority 検査を通す。`secure-io` の公開面を列挙する契約テストがあれば登録する。
- `agent-collaboration-projection.ts` の `readJsonlBounded` と terminal-hud `store/tail.ts` の `tailLines` をこれに置き換える(HUD 側の 2MB cap の「skip sentinel」は不要になるので、末尾 cap 読みに変更)。
- 受入: 29MB の fixture を与えても読み取り byte 数が `maxBytes` + 1 行分に収まること(`fs.readSync` 呼び出しの引数をスパイして検証)。

### AC-09: 注意項目・blocker の日本語ハードコード撤去

- 投影 `CollaborationAttentionItem` に `code: 'blocked' | 'waiting_human' | 'review_pending' | 'failure'` を追加。`title` / `next_action` は開発者向け英語の固定文に置き換え(core は user-facing 文言を持たない)、`reason` は従来どおり event summary。
- `agent-activity-board.ts` の blocker `reason` を英語の固定文 + 構造化フィールド(`dependency_ids?: string[]`)に置き換え、`'(未割当)'` は定数 `UNASSIGNED_AGENT_ID = 'unassigned'` に。
- surface: terminal-hud(`store/coordination.ts` の attention 行、`store/agent-graph.ts` の detail)と Chronos(`AgentCollaborationBoard.tsx` の attention、`api/agent-activity` の消費者)は `code` / `kind` から vocabulary(`tui_attention_<code>`、`chronos_ac_attention_<code>_title` / `_next`、`*_blocker_<kind>`、`*_unassigned`)で翻訳する。
- 受入: `grep -n "[ぁ-んァ-ン一-龥]" libs/core/agent-collaboration-projection.ts libs/core/agent-activity-board.ts` が 0 件(コメント除く)。`L` でロケールを切り替えると attention 行が英語になる。

### AC-10: supervisor イベントのローテーション

- `agent-runtime-events.ts` の `appendSupervisorEvent` を日付付きファイル `agent-runtime-supervisor-events-YYYY-MM-DD.jsonl` に書き換え(worker-events と同じ規約)。読み手向けに `listSupervisorEventFiles({ recentDays?, includeLegacy? })` を同ファイルに追加し、旧単一ファイルは最古として含める。
- 読み手 3 箇所(`agent-collaboration-projection.ts` の `JSONL_SOURCES`、`report-ops.ts`、`mission-retrospective.ts`)を helper 経由に移行。
- `storage-janitor.ts` に保持日数(既定 14 日、`retention` 設定に登録)を追加。
- 30 秒ごとの `a2a_inflight_metric` は値が変わったときと 10 分に 1 回だけ書く(emit 側でスロットル)。
- 受入: 1 日分の metric が 2,880 → ≤ 144 件。日付跨ぎで新ファイルが作られ、`recentDays: 2` で 2 ファイルだけ読まれる。

### AC-11: peer transcript の表示と peer エッジ

- `peer-conversation.ts` に `listPeerConversationPeers(tenantId)`(runtime root の `peers/` を列挙)、`collectPeerTranscriptTails(tenantId, { maxPerPeer })`(peer ごとに最新セッションの transcript 末尾)、`readPeerConversationEdges(tenantId, { since })`(observability `events.jsonl` の `peer_id → remote_peer_id`)を追加。
- 投影の `readSourceEvents` に peer-conversations を source `a2a` として加え、`sender = peer_id`、`receiver = remote_peer_id`(direction が inbound なら逆)、kind `handoff`。
- terminal-hud `agent-graph` の detail: ノード label が peer id(local または remote)と一致するとき、その peer の transcript 末尾 5 件を表示。tenant は `currentScope()` から取り、取れなければ黙って省略。
- 受入: fixture の 2 peer 会話から handoff エッジが 1 本出る。HUD の detail に transcript 行が出る(view-model テスト)。

### 第 2 期 Wave

| Wave | 項目                                                                                                    | 担当   | 所有ファイル                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | AC-08(primitive のみ)                                                                                   | sonnet | `libs/core/secure-io.ts`, その test, `presence/displays/terminal-hud/src/store/tail.ts` + test                                                                        |
| A    | AC-10(writer・janitor・report-ops/retrospective の読み手・metric スロットル)                            | sonnet | `libs/core/agent-runtime-events.ts`, `storage-janitor.ts`, `report-ops.ts`, `mission-retrospective.ts`, `a2a-bridge.ts`(metric 発行箇所のみ), 各 test, retention 設定 |
| A    | AC-11(core helper のみ)                                                                                 | sonnet | `libs/core/peer-conversation.ts` + test                                                                                                                               |
| B    | 投影統合(AC-08 の `readJsonlBounded` 置換、AC-10 の dated 読み、AC-11 の peer source)+ AC-09 の core 側 | opus   | `agent-collaboration-projection.ts`, `agent-activity-board.ts`, 各 test, schema                                                                                       |
| B    | AC-09 / AC-11 の surface 側                                                                             | sonnet | terminal-hud `store/coordination.ts` `store/agent-graph.ts` + tests、Chronos board / agent-activity route、vocabulary(tui / chronos)                                  |

## 6. 実装状況

| Wave | 項目                   | 状態             | コミット           | 備考                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------- | ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | AC-01                  | DONE(2026-09-06) | `3063d7550`        | レビューで 2 件修正: 本番経路では chain 末尾が自分自身のプレースホルダ `subagent:<dispatcher>:<tier>` になるため 1 つ手前を親にする / `agent_id` は begin/end で不変(native の id は `thread_id` に分離)。`readFocusedMissionId` を使うと `mission-state → governance → … → agent-dispatch` の runtime cycle(SCC 33→34)になるため focus JSON を secure-io で直読み                                                                                                                                                                                          |
| 0    | AC-02 + AC-03          | DONE(2026-09-06) | `f5459d1d1`        | レビューで 3 件修正: テストが実 observability ファイル(29MB 級)を上書き・復元していたのを `roots` 注入 + `shared/tmp` fixture に変更 / `missionId` 指定時はそのミッションの worker-event partition を日付窓に関係なく読む / worker envelope の `payload.status` と `payload.agent_id`(子)を持ち上げないと `subagent_end` の `fallback` が子ノードに反映されない。`a2a_message_routed → handoff` の分類も追加。`secure-io` に range read が無いため byte 上限は「読み込み後に末尾を切る」実装(parse 量は有界、disk read は全量)— 真の tail read は follow-up |
| 1    | AC-04                  | DONE(2026-09-06) | `b552e9207`        | `composeCollaborationTree` / `flattenCollaborationTree`。承認の突合に必要な `request_id` / `channel` を worker payload から持ち上げ。spawn の循環は開始時刻の全順序で前向きエッジだけ残す                                                                                                                                                                                                                                                                                                                                                                   |
| 2    | (追加修正)             | DONE(2026-09-06) | `158ae6daa`        | **実データで描画して発覚**: 投影は `limit`(200)で新しい順に切ってからグラフを作っており、実環境の最新 200 件は worker の `turn_*` と supervisor の `a2a_inflight_metric`(30 秒ごと、1 日 2,880 件)なのでグラフが空だった。`limit` は返却 feed だけに適用し、グラフ・注意・overview は窓内の全イベントから作る。`turn_*` / `*_metric` / `*_heartbeat` を既定除外、`recentDays` をイベント `ts` にも適用(orchestration-events.jsonl は単一ファイルで全履歴を持つ)。`mission_owner_notified` を progress に分類                                                |
| 2    | AC-05                  | DONE(2026-09-06) | `789b3a999`        | パネル 9「連携」+ cockpit 1 行。README の `tui:once`/`tui:dev` は `pnpm tui --once`/`--dev` に訂正(script 追加は SX-05 ラチェットで取り下げ)。HUD は 7 日窓、root は最終イベント降順。peer-conversation transcript の detail 表示は agent_id → peer_id の対応が無く未実装(§5 に移す)                                                                                                                                                                                                                                                                        |
| 2    | AC-06                  | DONE(2026-09-06) | `3246200cc`        | `GET /api/collaboration` に `tree` を additive 追加、`AgentCollaborationBoard` に折りたたみ「連携ツリー」section。SSE stream は投影本体を流さないので変更なし                                                                                                                                                                                                                                                                                                                                                                                               |
| 2    | AC-07                  | DONE(2026-09-06) | `06ec5f816`        | `knowledge/product/architecture/agent-collaboration-view.md`、SURFACES / COMPONENT_MAP                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2b   | base 修正              | DONE(2026-09-06) | `9331528b0`        | `provider-capabilities.schema.json` の `$defs`→`definitions`、`libs/core/tsconfig.json` に `native-pptx-engine/**`、e2e mock の `/tmp` を `active/shared/tmp` へ。これで `mission_controller`・a2a-bridge・collaboration e2e・`core-runtime-import-contract`・`workspace-build-contract` が green                                                                                                                                                                                                                                                           |
| A    | AC-08                  | DONE(2026-09-06) | `086fed7c5`        | `safeReadFileTail`(短読みループ付き)、HUD `tail.ts` の skip sentinel 撤去                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A    | AC-10                  | DONE(2026-09-06) | `353da5b47`        | 日付付き supervisor ファイル、`listSupervisorEventFiles` / `readSupervisorEvents`、janitor 14 日保持(retention catalog 1.4.0)、`a2a_inflight_metric` を変化時 or 10 分ごとに                                                                                                                                                                                                                                                                                                                                                                                |
| A    | AC-11(core)            | DONE(2026-09-06) | `7266f1d1f`        | `listPeerConversationPeers` / `collectPeerTranscriptTails` / `readPeerConversationEdges`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B    | 投影統合 + AC-09(core) | DONE(2026-09-06) | `42ccb49dd` `+fix` | tail primitive・dated supervisor・peer source(`a2a`)・attention `code`・blocker 構造化・`UNASSIGNED_AGENT_ID`。実データ 60 日分の投影が 140ms。追加修正: 応答済み approval を attention / waiting_human から除外                                                                                                                                                                                                                                                                                                                                            |
| B    | AC-09 / AC-11(surface) | DONE(2026-09-06) | `865ce8f97`        | HUD / Chronos が code・kind から翻訳、HUD detail に peer transcript。surface から日本語リテラルが消えたことを grep で確認                                                                                                                                                                                                                                                                                                                                                                                                                                   |

既知の無関係な失敗(base `751d156eb` でも同じ、本ブランチでは `9331528b0` で解消済み): a2a-bridge / collaboration e2e の schema `$defs` 欠落、`native-pptx-engine` の dist 未出力。未解消で本計画外: `tests/process-boundary-governance.test.ts`(`mission-maintenance` / `pipeline-approval-resume`)、`tests/core-fs-exception-boundary.test.ts`(許可リストが 40 ファイル分乖離)、`tests/package-boundary-contract.test.ts`(actuators / scripts 4 件)。
