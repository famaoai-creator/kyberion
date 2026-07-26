---
title: エージェント協調可視化計画
tags: [ux, agent-collaboration, mission-control, observability, chronos, trace]
last_updated: 2026-07-26
status: in_progress
mission_id: MSN-AGENT-COLLAB-OBSERVABILITY-20260726
---

# UX-07: 人間とAIが協調して動く状況の可視化

## 結論

導入可能であり、Kyberion では新しいオーケストレータを別製品として追加するより、既存の Mission Control・タスクイベント・Worker Event Stream・Trace・Chronos を **協調観測面 (Agent Collaboration View)** として統合するのが最も自然である。

参考にした二つのプロジェクトから取り込むのは実装そのものではなく、次の運用概念である。

| 参照                                                  | 取り込む概念                                                                                            | Kyberion での扱い                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 作業項目、エージェントごとの実行ワークスペース、差分/レビュー、プレビューを一つの作業面で見る           | Mission/Task/Artifact/Review/Surface の関係を一画面で追えるようにする。リポジトリ自体は依存しない                                                   |
| [OpenAI Symphony](https://github.com/openai/symphony) | tracker からの dispatch、bounded concurrency、隔離 workspace、retry/reconciliation、構造化ログ、handoff | Kyberion の mission/task/lease/orchestration journal/Trace を UI 用の読み取り投影へ正規化する。Symphony の高信頼 preview 実装をそのまま埋め込まない |

Vibe Kanban は現在 sunsetting を告知しているため、画面や内部 API の模倣を採用根拠にしない。一方、Symphony の仕様は rich web UI を非目標とし、observability を構造化ログと任意の status surface に分けている。この差を踏まえ、Kyberion 側では既存の安全なイベント正本と、用途別に薄い投影を作る。

## 目的

人間が Chronos または operator surface を開いたとき、10 秒以内に次の四つを判断できる状態を作る。

1. 今、誰（人間・親エージェント・子エージェント・surface）が動いているか。
2. 何の目的で、どの Task/Artifact に対して動いているか。
3. 次に誰へ何が渡るか、どこで待っているか。
4. 人間の承認・判断・介入が必要か、失敗時に何が根拠として残っているか。

## 現状の再利用可能な基盤

| 層             | 既存実装                                                                                                 | 評価                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Mission/Task   | `mission-state.json`、`mission-task-events.ts`、`mission-orchestration-events.ts`、orchestration journal | lifecycle と因果関係の正本候補。新たな mission state machine は作らない                                |
| Agent runtime  | `agent-registry.ts`、runtime supervisor、`/api/agents`、Agent Activity Board                             | provider/model/status/last activity は既に取得可能。mission/task への結び付きを強化する                |
| Event stream   | `worker-event-stream.ts` の `WorkerEventEnvelope`、JSONL recorder/replay                                 | UI のリアルタイム入力にできる。既存の `mission_event`/`subagent_*` を失わない additive 拡張にする      |
| Trace/evidence | Trace、`active/shared/logs/`、mission evidence、artifact/review receipt                                  | 「完了した」ではなく「何を根拠に完了したか」をリンクできる                                             |
| A2A/handoff    | A2A bridge、handoff packet、lease、task contract                                                         | agent 間の受け渡しを可視化できる。payload 本文は tier policy で隠す                                    |
| Operator UI    | Chronos `MissionIntelligence`、`FocusedOperatorView`、`TraceViewer`、`AgentOpsBoards`、operator-surface  | 新規の別ダッシュボードを作らず、Chronos に協調ビューを追加し operator-surface は読み取り投影を共有する |

## 解消すべきギャップ

1. `mission-event.schema.json`、task event、worker event が別々の envelope で、mission → task → agent → artifact → human decision の一本の流れを UI が再構成する契約がない。
2. 状態のスナップショット、イベントの時系列、Trace の span、A2A の handoff が別表示であり、「なぜこの状態か」を一画面で説明できない。
3. `ready/busy/error` は runtime 状態であって、`waiting_for_human`、`blocked_by_dependency`、`review_pending`、`retry_scheduled` のような operator 状態と分離されていない。
4. 現在の activity board は集計に強いが、担当 Task、因果元、証跡、次のアクション、停止理由まで辿るには追加の投影が必要である。
5. polling だけではイベントの欠落・重複・古い投影を説明しづらい。まず cursor/sequence を持つ replayable read API を作り、その後に SSE を追加する。

## 目標アーキテクチャ

```text
mission/task/orchestration/worker/a2a/trace writers
                │  additive adapters
                ▼
     Agent Collaboration Event v1 (append-only)
       mission-local SSoT + shared redacted index
                │
        cursor / replay / tier filter
                ▼
 Collaboration Projection (read-only, deterministic)
   ├─ overview: mission/task/agent counts and attention
   ├─ graph: parent → child → handoff → artifact
   ├─ timeline: event, cause, actor, evidence, next action
   └─ operator queue: approval/review/blocked/retry
                │
       Chronos API + operator-surface read API
                ▼
         人間が理解・介入・レビューする UI
```

### 正規イベント契約

新しい `agent-collaboration-event.v1` は既存イベントを置換せず、投影用の正規形へ変換する。最低限、以下を持つ。

- `event_id`, `ts`, `seq`, `schema_version`
- `mission_id`, `task_id`, `agent_id`, `parent_agent_id`, `session_id`
- `actor_type`: `human | agent | surface | system`
- `kind`: `dispatch | claim | spawn | progress | waiting | blocked | handoff | approval | review | artifact | retry | failure | completion`
- `state_before`, `state_after`, `reason_code`, `summary`
- `correlation_id`, `causation_id`, `related_ids`
- `evidence_refs`: trace/span/artifact/review/approval の参照だけ。本文は含めない
- `tier`, `tenant_slug`, `redaction`: shared index に出せる範囲を明示
- `source`: `mission | task | worker | orchestration | a2a | trace | surface`

`summary` も prompt や秘密値を含まない bounded text とし、raw model output、credential、confidential payload は保存・共有しない。欠落イベントを補うために UI が推測で状態を作ることは禁止し、`unknown`/`stale`/`sequence_gap` を明示する。

### 投影の責務

- event log が唯一の書き込み正本で、projection は再生成可能な read model とする。
- mission/tier/tenant の境界は event reader と API の両方で検証する。
- `current`, `attention`, `timeline`, `graph` の4投影を同じ cursor から生成し、表示ごとに別の意味論を持たせない。
- operator action は projection に直接書かず、既存の mission controller、approval store、surface steering、review API へ戻す。

## 実装フェーズ

### Phase 0: 契約確定と観測棚卸し

- `agent-collaboration-event.v1` schema、event kind/state vocabulary、redaction/tier 方針を追加する。
- mission task、orchestration、worker、A2A、Trace の現行イベントを一覧化し、各 producer からの mapping table を作る。
- 同一イベントを二重記録しない `source_event_id` と `causation_id` のルールを固定する。
- 成果物: schema、mapping table、golden event fixture、データ階層/保持方針。

### Phase 1: 共通 writer/normalizer

- `libs/core/agent-collaboration-events.ts` を追加し、既存 writer から additive に emit する。
- `WorkerEventStream` は共通 envelope の source/sequence を再利用し、mission/task/agent の ID を欠落させない。
- `mission-task-events.ts`、`mission-orchestration-events.ts`、A2A handoff、runtime supervisor、approval/review/artifact receipt を adapter 接続する。
- mission-local JSONL と shared redacted JSONL を分け、shared 側は `resolveSharedObservabilityDir` と secure-io を通す。

### Phase 2: 決定論的 projection/query

- `libs/core/agent-collaboration-projection.ts` を追加し、cursor 付き replay、sequence gap、stale runtime、blocked reason、attention item を純関数中心に実装する。
- `buildCollaborationOverview`、`buildCollaborationGraph`、`buildCollaborationTimeline`、`buildOperatorAttentionQueue` を公開する。
- event source が異常でも UI 全体を落とさず、`partial` と欠落 source をレスポンスへ含める。
- 長い payload は summary と evidence ref に圧縮し、raw log は TraceViewer など既存の権限付き導線からのみ開く。

### Phase 3: Chronos/operator surface UX

- Chronos に `/api/collaboration` の read-only GET を追加する。初期 transport は cursor polling/ETag とし、安定後に `/api/collaboration/stream` の SSE を追加する。
- `AgentCollaborationBoard` を追加し、Overview / Swimlane / Timeline / Attention の4モードを持たせる。
- `MissionIntelligence` は mission の目的・進捗・注意事項を表示し、`FocusedOperatorView` は agent/hand-off の関係を表示し、`TraceViewer` は証跡の詳細を担当する。
- 各カードに `誰が / 何を / なぜ / 次に誰へ / 何を根拠に` を固定表示する。色だけで状態を伝えず、文字ラベルと icon を併記する。
- operator-surface は同じ read projection を使い、権限のない write 操作を追加しない。

### Phase 4: 人間の介入とレビューへの接続

- `approval_required`、`review_pending`、`blocked`、`handoff_ready` を既存の approval/review/mission steering の action contract にリンクする。
- 画面からの操作は「承認」「差し戻し」「停止」「再開」「担当移管」の既存 governed facade に限定する。
- 操作前に対象、影響範囲、根拠、取り消し可否を確認し、実行直前に owner/lease/tier を再検証する。
- 人間の判断も `actor_type=human` の observation として記録し、AI の自動判断と混同しない。

### Phase 5: 検証・運用化

- fixture で親→子→handoff→artifact→review→completion の replay を実行し、同じ input から同じ projection が得られることを確認する。
- 3〜10 agent の並行 mission、retry、crash/restart、sequence gap、tier 混在、長時間 idle、human approval 待ちを golden scenario 化する。
- Chronos の表示検証、keyboard navigation、screen-reader label、ja/en vocabulary、mobile narrow width を確認する。
- event volume、projection latency、cursor lag、redaction rejection、operator intervention、unknown/stale 件数を `vital`/doctor に追加する。

## 変更対象候補

| 目的  | 主な対象                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 契約  | `knowledge/product/schemas/agent-collaboration-event.schema.json`、event/state vocabulary、必要なら contract baseline                                        |
| Core  | `libs/core/agent-collaboration-events.ts`、`libs/core/agent-collaboration-projection.ts`、既存 event writers、`libs/core/index.ts`/package exports           |
| API   | `presence/displays/chronos-mirror-v2/src/app/api/collaboration/route.ts`、必要なら stream route                                                              |
| UI    | `presence/displays/chronos-mirror-v2/src/components/AgentCollaborationBoard.tsx`、`MissionIntelligence.tsx`、`FocusedOperatorView.tsx`、`AgentOpsBoards.tsx` |
| Tests | core schema/normalizer/projection、mission/a2a/worker integration、Chronos API/UI、tier/tenant/no-write/SSRF 契約テスト                                      |
| Docs  | 本計画、`STATUS.ja.md` の UX 行、operator UX guide/API docs、replay/incident runbook                                                                         |

## 受入条件

1. 1つの mission で、親エージェントが子エージェントへ Task を渡し、子が Artifact を作り、人間レビューを経て完了する流れが、Overview/Graph/Timeline の全てで同じ ID と因果関係を示す。
2. operator は agent 数、担当、状態、停止理由、次の人間アクション、evidence ref を1画面から取得できる。
3. event log を削除して projection を再生成しても、同じ入力 fixture から同一 JSON が得られる。重複 emit は `source_event_id` で dedupe される。
4. restart/retry/sequence gap は黙って成功扱いにならず、`stale`/`unknown`/`sequence_gap` として表示される。
5. personal/confidential の raw payload が shared/public projection や別 tenant の UI に出ない。redaction と deny のテストがある。
6. UI の write 操作は既存の governed facade のみを使い、projection/event reader から直接 mission state を変更しない。
7. 既存の `pnpm pipeline --input pipelines/baseline-check.json`、関連 core/Chronos test、typecheck、build、governance/contract checks が緑である。

## リスクと非目標

- 非目標は Vibe Kanban の clone、Symphony の scheduler の置き換え、第二の mission state machine、全モデルの逐語的ストリーミングである。
- event の意味を UI 側で推測すると、表示と実行の状態が乖離する。正規化できないイベントは `unknown` として残す。
- shared observability は便利だが tier leak の危険が高い。shared には redacted summary と参照だけを置き、本文は mission-local に留める。
- SSE は接続数・再接続・cursor 再同期の複雑さを増やすため、Phase 3 の初期は polling/ETag で受入を通し、必要性が確認できた場合のみ導入する。
- 大量の trace を一画面に出すと理解性が下がる。既定表示は attention と因果要約に絞り、raw detail は TraceViewer へ遅延展開する。

## PR 分割と実装順

1. **契約 PR**: schema、vocabulary、golden fixtures、mapping table。
2. **core writer PR**: normalizer、producer adapters、tier/redaction、dedupe。
3. **projection/API PR**: replay/query、cursor、Chronos read-only route。
4. **Chronos UX PR**: board、swimlane、timeline、attention、既存画面との導線。
5. **介入/運用 PR**: governed action links、doctor/vital、runbook、実ミッション E2E。

各 PR は `origin/main` との差分を限定し、既存の未関連変更を含めない。実装開始時は本ミッションの `NEXT_TASKS.json` を基準にし、各 task を実装→focused test→独立レビュー→mission evidence の順で進める。

## 成功指標

- operator が「誰が何をしているか」「何待ちか」「次に何をすべきか」を 10 秒以内に答えられる。
- mission→task→agent→artifact→review の traceability 欠落率 0%。
- projection の再生で duplicate/missing/sequence-gap を検知できる。
- tier/tenant 境界違反 0 件、redaction rejection は fail-closed。
- 初期 UX では表示更新の p95 を 2 秒以内、再接続時の cursor 再同期を 1 回以内に収束させる。

## 実装状況

- 2026-07-26: 現行コード、既存 UX-02/SU/SO/AL/NI 計画、`vibe-kanban` README、`symphony` README/SPEC を突合し、本計画を作成。
- 2026-07-26: Phase 0〜3 の最小縦切りを実装。`agent-collaboration-event.v1` schema、secure/read-only な既存 JSONL normalizer、決定論的 projection（overview/attention/timeline/graph）、Chronos `/api/collaboration`、`AgentCollaborationBoard` を追加した。mission/task/worker/runtime の既存ログを置換せず、redacted summary と evidence ref のみを UI に投影する。core focused test、schema contract、core typecheck、Chronos production build、UI governance、baseline-check を検証済み。
- 2026-07-26: Phase 4 の第一段階として、Attention から Mission Control、承認キュー、Runtime Topology へ既存の operator view を開く導線を追加した。投影からの直接書き込みや自動再開は行わず、既存 governed facade を人間が確認して操作する境界を維持する。
- 2026-07-26: Phase 5 の第一段階として、source ごとの `sequence_gap`、未知イベント、active runtime の stale 状態を `status_flags` として決定論的に返し、golden 相当の projection test（human approval と agent failure の分離を含む）を追加した。
- 2026-07-26: 実データ probe で worker JSONL がファイル単位の sequence namespace であることを確認し、worker ファイル境界を欠番と誤認しないよう source-wide gap 判定から除外した。単一 stream として扱える source の欠落だけを `sequence_gap` にする。
- 2026-07-26: Phase 5 の golden replay fixture（10 agent、retry、crash、handoff、human approval、review、completion）と決定論的 replay assertion を追加した。`pnpm vital:json` にも協調イベント数、attention 数、agent 数、partial/status flags を追加し、既存の overall 判定は変更していない。
- 残作業: Phase 4 の approval/review/停止/再開の各 action contract への詳細リンク、3〜10 agent の実ミッション replay、doctor 画面への専用 finding、実ブラウザ表示・keyboard/screen-reader 検証。
