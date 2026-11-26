---
title: 'Loop Closure Machinery — 4つの自己改善ループの実装地図'
last_updated: 2026-11-25
---

# Loop Closure Machinery — 4つの自己改善ループの実装地図

> **対象読者**: このリポジトリを初めて見るモデル/エージェント。**5分でループ機構の全体像と「どこを触ればいいか」が分かる**ことを目的とする。
> **正本計画**: [LOOP_CLOSURE_PLAN_2026-07-13](../../../docs/developer/improvement-plans-archive/2026-07/LOOP_CLOSURE_PLAN_2026-07-13.ja.md)(LC-01〜12、全タスク実装済み 2026-07-13)
> **設計テーゼ**: Kyberion の肝は「決定論的な実行と LLM 推論をどの結合点で組み合わせるか」。ナレッジから決定論に落とせるものは落とし(蒸留)、組織・ミッションの情報資産は統制とエビデンス付きで管理する。本文書はそれを**運転し続けるための4ループ**の実装場所を示す。

## 全体像(1枚)

```
L1 実行成功→昇格     書く → preflight → 実行(失敗なら 決定論修復 → LLM修復 ×1回)
                      → 成功 → 再利用するなら pnpm pipeline:promote → pipelines/ カタログ

L2 LLM判断配置       決定論op → 蒸留+選択(llm_decide+options) → 蒸留+生成 →
                      schema強制委譲 → best-of-N → 人間  (6段ラダー、lint で逸脱警告)

L3 縮退防止          stub が判断を返したら記録(taint)→ 完了ゲートでブロック。
                      チェーン構築失敗は marker + 通知 + baseline needs_attention

L4 人間フィードバック 却下 → ask-why 1問(5カテゴリ) → イベントストリームに理由 →
                      rework タスク自動生成(再実行) + KnowledgeHint(学習)
```

## L1: 実行成功→再利用昇格

| 何             | どこ                                                                                              | 挙動                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| preflight      | `scripts/refactor/adf-input.ts` `readValidatedWorkflowAdf`                                        | schema(`validatePipelineAdf`)+ guardrails。error は throw                                                                                                                                                                                                                                                |
| 実行時修復     | `scripts/run_pipeline.ts` `runStepWithRepair` → `libs/core/pipeline/autonomous-repair.ts`         | 1修復+1再試行の有界ループ。**決定論修復が先**(`tryRepairJson`、パース不能な機械的破損はトークンゼロで修復)、意味的破損のみ LLM サブエージェントへ。permission/auth/config/env は fail-closed で ops エスカレーション                                                                                     |
| 修復の学習     | 同上(LC-03)                                                                                       | 検証済み修復の成功時に `repair:<category>:<op>` hint を persist、次回同クラス修復プロンプトに直近3件を注入                                                                                                                                                                                               |
| **昇格**       | `scripts/pipeline/pipeline_promote.ts` = **`pnpm pipeline:promote --input <adf> --run <run-id>`** | preflight → LLM 1問(placeholder 化・semantic step フラグ。stub では verbatim)→ `promotion` キーに出自 → 再 preflight → `pipelines/<slug>.json` + README カタログ行。`--run` は同一バイト列の成功したエンジン実行 journal が必須（`--draft` は無力な提案のみ）。`--dry-run` / `--no-llm` / `--force` あり |
| 昇格サジェスト | `run_pipeline` 成功時                                                                             | 入力が `pipelines/` 外なら「昇格しますか」1行を表示                                                                                                                                                                                                                                                      |

**ドクトリン**: まず成功まで持っていく(一回きりならそこで終わり)。再実行の見込み・同型反復が見えたら昇格する。未成功の ADF を先に凍結しない。

## L2: LLM 判断配置

- **正本**: [`knowledge/product/governance/llm-invocation-rubric.md`](../governance/llm-invocation-rubric.md) — 6段ラダーと判定質問。pipeline/タスク設計時はこれを先に読む。
- **lint**: `libs/core/pipeline/adf-guardrails.ts` — `llm-decide-without-distill` / `llm-decide-without-fallback`(既定 `warn`、`AdfGuardrailOptions.strictUncertaintyContract` または `knowledge/product/governance/adf-execution-policy.json` の `uncertainty.require_llm_decide_fallback: true` 指定時は `error` へ昇格し `runAdfLifecycle` で `autoRepair` を発火)。蒸留なし・fallback 宣言なしの `llm_decide` を preflight で検知。
- **プリミティブ**: `libs/core/reasoning/semantic-decide.ts` `decideFromObservation`(選択>生成、options 外は拒否→null)、`delegateStructured<T>`(schema 強制+retry)、`delegateBestOf`(N案+judge)— すべて `libs/core/reasoning/reasoning-backend.ts`。
- **蒸留→判断の全面展開**(AR-07 完了): `llm_decide` は全5 actuator で利用可能。op 本体は共通ヘルパ `executeLlmDecideOp`(semantic-decide.ts)。蒸留段: browser `distill_dom` / android `summarize_ui_tree` / system `distill_output` / network `distill_response`(後2者は `libs/core/reasoning/observation-distill.ts` — head/tail/error行・JSON shape・HTML title+links)/ terminal は observation 明示必須。
- ワーカーへの周知: `libs/core/workforce/working-principles.ts` の strategist 追補にラダー参照が入る(全 worker prompt に注入)。

## L3: 縮退防止(stub へのサイレント縮退の遮断)

| 経路                             | 防衛線                                                                                                                                                                                                 | どこ                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 実行中のプロバイダ障害           | (元から安全)failover → warn + demotion → 全滅時 throw。stub は failover 候補に入らない                                                                                                                 | `reasoning-backend.ts` `FailoverReasoningBackend`                                                                                                      |
| インストール時にチェーン構築失敗 | marker 書き込み + `notifyOperator` 1回 + **baseline-check が `needs_attention`**(report に `reasoning_degraded`)                                                                                       | `libs/core/reasoning/reasoning-degradation.ts` + `reasoning-bootstrap.ts` + `scripts/run_baseline_check.ts`。旧挙動は `KYBERION_ALLOW_STUB_FALLBACK=1` |
| stub が判断を返して偽成功        | **stub-taint**: stub 全メソッドの呼び出しを記録し、完了突合(`reconcileCompletionStructurally`)が taint 検出時に `satisfied=false` + `reasoning_stub_served` gap を強制                                 | `reasoning-backend.ts` `getStubServedOps` + `intent-reconciliation.ts`。明示 `KYBERION_REASONING_BACKEND=stub`(決定論テスト)は免除                     |
| `llm_decide` の null 縮退        | 理由付き記録(model_error / option_rejected / empty_decision)+ `<export_as>_degraded` export + run summary 表示。`on_degraded: fail` + `degraded_threshold`(既定3)で連続 model_error を step failure 化 | `semantic-decide.ts` 縮退レジストリ + browser `llm_decide` op                                                                                          |

## L4: 人間フィードバック(却下→理由→再実行→学習)

**貫通フロー**(すべて実装済み):

```
人間が reject / request-changes
  → ask-why 1問(スキップ可): 内容が誤り/方向が違う/品質不足/スコープ過不足/その他
      UI: chronos 成果物レビュー + chronos 承認キュー
  → note + reason_category が承認イベント JSONL / review entry に永続化
  → [再実行] 再突入キュー(libs/core/workforce/review-reentry.ts)に enqueue
      → mission finish / review-reenter が pending 要求を処理
        - 既定(OFF): completion reconciliation の gaps に合流 → IL-04 が一律 `goal-gap-*` (`implementer` + `reviewer`) を生成
        - opt-in(ON: `state.context.requirements_change_level_routing: true` または `mission-brief.json` の `requirementsGovernance.changeLevelRouting: true`): `libs/core/mission/mission-reentry-routing.ts` がカテゴリを L1/L2/L3 にルーティング
          - `L1_goal_purpose`(`wrong_direction`): `status: 'paused'` + `alignment_reapproval_required: true` + `product_strategist` 再アラインメント → `reviewer`
          - `L2_requirement_process`(`scope`): `product_strategist` 仕様更新 → 依存 `implementer` → `reviewer`
          - `L3_implementation_model`(`incorrect_content`/`quality`/`other`): 有界 `implementer` 修正 → `reviewer`
      → 上限 KYBERION_GOAL_LOOP_MAX_ROUNDS(既定2)、超過は operator エスカレーション
  → [学習] human-rejection:<category>:<request-id> の KnowledgeHint を保存
      (テナント内で共有。ナレッジ検索にはカテゴリ別の教訓を取り込む)
      (ワーカーには同じ Mission、同じ Project の順で具体例を優先し、別 Project は教訓のみ)
      + KM-03 promotion queue に memory candidate(統治付き、直接 HINTS.md は書かない)
```

- **共有語彙**: `libs/core/contracts/rejection-reason.ts`(5カテゴリ + `normalizeRejectionReasonCategory`)。カテゴリを閉じているのは学習側の dedup を決定論化するため。
- **機械由来のギャップ**(goal 不充足)は IL-04 が元から閉じている。L4 はそこに**人間由来の却下を同じ状態機械で合流**させた(新設なし)。
- **会話中の自然な訂正の捕捉 (IL-05)**: `libs/core/knowledge/conversational-correction-learning.ts` が `surface-runtime-orchestrator` 上のスコープ付き会話ターンから「今後は〜して」「〜しないで」等の選好・境界ルールを `intent-phrase-lexicon.json` で検出し、レビュー可能な `MemoryCandidate` を生成する(権限・手順は自動変更しない)。
- **記憶ループ健全性と自律ループ診断**: `libs/core/knowledge/memory-loop-health.ts` が `promoted / retrieved / used` と `loop_status` (`idle | delivery_open | usage_open | closed`) を計測し、`libs/core/governance/autonomous-loop-readiness.ts`（`pnpm tsx scripts/pr/pr_shadow.ts report --loop-readiness`）が heartbeat（active dot は `daemon_watchdog` と同じ `runtime.max_idle_wake_ms` を適用） / active dot / memory loop（`--tenant` 省略時は登録済みテナントを集約） / factory readiness を統合診断する。
- **確認順**: `--json` の `loop_readiness.diagnostics` で運用上のブロッカーと学習の注意点を判別できる。`next_check` は運用上のブロッカーを優先し、テキスト出力にも最初の確認先を表示する。`--tenant` は記憶・factory の対象を指定する。heartbeat と dot wake はワークスペースの運用診断として扱う。

## 主要な環境変数

| 変数                              | 効果                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `KYBERION_REASONING_BACKEND=stub` | 明示 stub(決定論テスト)。taint ゲート免除                                                   |
| `KYBERION_ALLOW_STUB_FALLBACK=1`  | チェーン構築失敗時の fail-loud を無効化(旧挙動)                                             |
| `KYBERION_GOAL_LOOP_MAX_ROUNDS`   | goal/review rework の往復上限(既定2)。review-reenter コマンド経由は上限なし(人間の明示実行) |
| `KYBERION_BEST_OF_N=0`            | best-of-N 品質機構の opt-out                                                                |

## 触るときの注意(初見向け)

1. **完了判定を触るなら** `reconcileCompletionStructurally` が単一の関所(task-session close と mission finish の両方が通る)。ここに条件を足せば全 shape に効く。
2. **却下理由の消費者を増やすなら** イベント JSONL(`active/shared/observability/channels/<ch>/approvals.jsonl`)と review-reentry レコード(`active/shared/coordination/review-reentry/<MISSION>/`)を読む。nested workflow record は読まない(死蔵の旧経路)。
3. **hints の読み書き**は `persistHints` / `readHintsByCategory`(`libs/core/knowledge/feedback-loop.ts`)。カテゴリ = ファイル名。topic で dedup される。100件でローテーション。
4. **テストの定石**: governed artifact を触るテストは secure-io をモックし、**論理パスを KYBERION_ROOT 起点で解決する**こと(`libs/core/workforce/review-reentry.test.ts` 冒頭のコメント参照。素通しの fs モックだと実リポジトリに書いてしまう)。
5. **フォローアップ接続も実装済み**(2026-07-13 後続): (a) ワーカー brief に直近の却下教訓を注入(`buildRejectionLessonLines`)、(b) `llm_decide` 縮退の週次集計が operator packet に載る(`libs/core/reasoning/semantic-degradation-log.ts` → orchestrator status report)、(c) アドホック ADF の成功3回で昇格候補として run_pipeline と operator packet に提示(`libs/core/pipeline/promotion-candidates.ts`)、(d) Slack 承認却下の ask-why ボタン(`slack_approval_askwhy` action → `annotateApprovalRejectionReason` で決定後の理由をイベントストリームに追記)。真の残りは iMessage/Telegram ブリッジへの同型展開と、会話文中の修正意図検知(IL-05)のみ。
