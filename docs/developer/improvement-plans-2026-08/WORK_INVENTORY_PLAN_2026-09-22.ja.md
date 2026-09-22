---
title: 業務棚卸しと実データ学習ループ計画
tags:
  [improvement-plan, 2026-08, work-inventory, learning, automation-candidate, observation, consent]
last_updated: 2026-09-22
status: active
---

# 業務棚卸しと実データ学習ループ計画 (WI-01〜WI-12)

**ミッション**: `MSN-WORK-INVENTORY-20260922`
**起点の問い**: 「仕事を PC 上の行為まで分解し、API / AI / 画面操作 / 人間のどれに任せるかを振り分ける考え方と Kyberion のコンセプトを比べるとどうか。いよいよ実データを集め、学習し、改善する段階に来ている」

## 0. 結論(先に)

Kyberion の意図ループ(受信 → 明確化 → 保管 → 実行 → 検証 → 学習)は _人が意図を口にしたところ_ から始まる。**人が日々 PC の前で何をしているかを観測・分解して自動化候補を見つける段(発見段)がない**。本計画はこの発見段を意図ループの前段として足し、集めた実データを学習と改善まで一周させる。

> **棚卸しは「業務 → 7 段 × 12 行為のステップ → 実行手段」の構造化記録として保管し、実行手段の判定は宣言的な規則で行う。LLM は分解の提案者に限る。候補の順位は実データ(頻度・所要時間・実行結果)で校正し、昇格後の実績で重みを学習する。**

ボトムアップの棚卸しをそのまま凍結すると、画面変更で壊れる RPA に戻る。そのため昇格は既存の段(scratch → パイプライン、alignment gate → mission)を通し、判断を要するステップは semantic brief のまま残す。

## 1. 現状監査(2026-09-22 実測)

### 1.1 既にあるもの

| 領域          | 実体                                                                                                                                                                                                | 状態                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| ヒアリング    | `presence/displays/presence-studio/hearing*.ts`(`web_app_build` シナリオはコード直書き、保存先 `active/shared/tmp/hearing/` は TTL 1 日)                                                            | 稼働。シナリオカタログなし                               |
| 利用ログ      | `active/shared/logs/traces/*.jsonl`、`feedback-loop/adhoc-pipeline-runs.json`(`listPromotionCandidates` 閾値 3)、`unhandled-intent-registry.json`、`distill-candidates/`                            | 稼働しデータあり                                         |
| PC 操作の記録 | `desktop-recording.ts`(active_window / clipboard ハッシュ / browser_tabs / focused_input / screen_frame)、`browser-extension-bridge.ts`、`desktop-intent-reconstruction.ts`、`pnpm kyberion record` | 稼働。**本人同意の記録なし**。`runtime/recordings/` は空 |
| 学習          | `operational-learning.ts`(組織の学習候補キュー)、`execution-feedback.ts`、`mission-distill.ts`                                                                                                      | 稼働                                                     |
| 未配線        | `trace-procedure-candidate.ts` / `task-distill-candidate.ts` / `heuristic-feedback.ts`                                                                                                              | 呼び出し元なし                                           |

### 1.2 欠けているもの

1. **業務という単位がない**。トレース・記録・ヒアリングはあるが、それらを「同じ業務の観測」として束ねる記録型がない。
2. **実行手段の振り分けがない**。どのステップが API / 画面操作 / AI / プログラム / 人間 向きかを判定・保持する場所がない。
3. **頻度 × 所要時間の実データがない**。`adhoc-pipeline-runs` は完全一致パスの回数だけで、人手の業務時間は測っていない。
4. **PC 操作記録に同意の記録がない**。記録の承認・却下はあるが、「誰が・何を・いつまで記録されることに同意したか」が残らない。
5. **昇格後の結果が戻らない**。自動化した後に実際どれだけ走り、どれだけ人手が減ったかが候補の順位に反映されない。

## 2. 設計

### 2.1 記録型(`work-inventory.v1`)

```text
WorkInventoryEntry(業務 1 件)
  entry_id, title, scope{tenant_slug?, organization_id?, owner_member_id?}
  trigger{kind: schedule|event|request|ad_hoc, description}
  frequency{per: day|week|month|quarter|year, count}
  effort_minutes_per_run, actors[], systems[]
  steps[]:
    step_id, stage (trigger|gather|understand|decide|act|verify|record)
    verb (receive|search|read|input|transform|judge|create|operate|communicate|manage|record|coordinate)
    description, system?, data_sensitivity (public|internal|confidential|personal)
    effects[] (external_send|money|personal_data|irreversible|approval)
    method{ assigned: api|computer_operation|ai_reasoning|program|human,
            source: rule|proposal|human_override, rule_id?, rationale }
    binding?{ actuator?, op?, pipeline_id?, intent_id? }
  observations[] (source: self_report|kyberion_trace|desktop_recording|browser_recording, ref, observed_at, digest)
  status: draft|confirmed|candidate|promoted|retired
  promotion?{ kind: mission|pipeline, ref, promoted_at, decided_by }
  outcomes[]?{ measured_at, runs, minutes_saved_estimate, failures, source }
```

保存先は `knowledge/confidential/<tenant>/work-inventory/`(テナント指定なしの個人利用は `knowledge/personal/work-inventory/`)。`storage-retention-catalog.json` に登録する。

### 2.2 振り分け規則(`work-inventory-taxonomy.json`)

- 7 段・12 行為・5 手段の語彙と、行為 × 条件 → 手段 の規則表を宣言的なカタログとして持つ。
- 規則の例: `effects` に `money` / `irreversible` / `approval` を含むステップは `human`(判断は人間だけ — FD-10 と整合)。`system` が API 連携済み(service binding あり)の `input` / `communicate` は `api`。`read` / `understand` は `ai_reasoning`。`transform` は `program`。API のない業務システムへの `input` / `operate` は `computer_operation`。
- 行為ごとに Kyberion の actuator 候補(email / ingest / vision / browser / artifact / calendar / meeting / approval …)を持ち、`binding` の初期値にする。
- LLM は分解(自由記述 → ステップ列)の提案だけを担う。手段は必ず規則で再判定し、規則と提案が食い違ったら `rationale` に両方を残す。

### 2.3 データの集め方(3 系統)

| 系統                | 入口                                                                       | 何が取れるか                           |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| ① 自己申告          | 相棒「頼む」のヒアリング `scenario=work_inventory` と `pnpm inventory add` | 業務名・契機・頻度・所要時間・手順     |
| ② Kyberion 利用ログ | `pnpm inventory harvest`(トレース、繰り返し実行、未処理意図、ミッション)   | 実頻度・実所要時間・失敗               |
| ③ PC 操作の記録     | 同意の記録を通した `desktop-recording` / `browser-recording` の取り込み    | 実際の操作列(アプリ・画面・操作の種類) |

③ の原則:

- **同意は記録として残す**。`consent{member_id, sources[], purpose, granted_at, expires_at, revoked_at?}`。期限切れ・撤回・範囲外の記録は取り込みを拒否する。
- **生の記録は本人の personal 層から出さない**。棚卸しに入るのは、本人が確認した要約(アプリ名、操作の種類、回数、所要時間)だけ。入力テキストとクリップボードは取り込まない(既存の記録もハッシュのみ)。
- personal → confidential への移動は本人の承認を経由し、監査ログを残す。

### 2.4 学習と改善のループ

```text
集める(①②③) → 業務に束ねる → 規則で振り分け → 候補の順位付け
  → 昇格(alignment gate → mission / pipeline:promote) → 実行実績の計測
  → 重みの校正 + 組織の学習候補キューへ信号 → 次の順位付け
```

- **順位**: `頻度 × 所要時間 × 自動化可能割合 × 観測の確からしさ − 危険度`。重みは `calibration`(テナント単位)に置き、既定値はカタログに置く。
- **昇格**: 候補 → `mission`(既存のヒアリング hand-off と同じ alignment gate を通す)、または繰り返しが確認済みなら `pipeline:promote` の入力にする。判断は人間(`decided_by`)。
- **実績**: 昇格先の実行(トレース / 繰り返し実行台帳 / mission 状態)から `outcomes` を記録し、予測との差を `calibration` に反映する。差が大きい業務は `operational-learning` の学習候補として組織キューに送る。

### 2.5 実装上の原則

- ファイル I/O は `@agent/core/secure-io` のみ。カタログは `defineCatalog` + JSON Schema。
- 振り分け・順位・校正はすべて型付き TypeScript の純関数にし、入出力を固定したテストを書く。
- CLI は `pnpm inventory`(`defineScript`、`cli-commands.json` に登録)。
- 利用者向けの文言は `user-facing-vocabulary.json` の `front_desk` 領域。

## 3. 項目一覧

| ID    | 区分   | 内容                                                                                                                                                                     | 優先度 |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| WI-01 | 土台   | 語彙・振り分け規則のカタログ `work-inventory-taxonomy.json` と、記録型・カタログの JSON Schema                                                                           | P0     |
| WI-02 | 土台   | `libs/core/work-inventory.ts`: 型、検証、規則による手段判定 `classifyWorkStep`、テナント単位の保存・一覧                                                                 | P0     |
| WI-03 | 収集②  | `libs/core/work-inventory-harvest.ts`: トレース・繰り返し実行・未処理意図から需要信号を作り、業務に紐づける                                                              | P1     |
| WI-04 | 収集①  | `libs/core/work-inventory-decompose.ts`: 自由記述 → ステップ列の LLM 提案(推論バックエンド経由、スキーマ検証、規則で再判定、stub で決定的)                               | P1     |
| WI-05 | 収集③  | `libs/core/work-inventory-consent.ts` + `work-inventory-observation.ts`: 同意の記録(付与・撤回・期限)と、同意済みの desktop / browser 記録の要約取り込み(本人確認、監査) | P1     |
| WI-06 | 学習   | `libs/core/work-inventory-scoring.ts`: 候補の順位付けと、テナント単位の校正                                                                                              | P1     |
| WI-07 | CLI    | `pnpm inventory`(add / list / show / classify / decompose / harvest / consent / observe / candidates / promote / outcomes / calibrate)                                   | P1     |
| WI-08 | 収集①  | ヒアリングのシナリオカタログ化と `work_inventory` シナリオ、確定時の棚卸し記録への受け渡し                                                                               | P1     |
| WI-09 | 改善   | 昇格(mission / pipeline)と実績計測、校正、組織学習キューへの信号                                                                                                         | P1     |
| WI-10 | 登録   | 標準意図 `inventory-work` と intent-outcome パターン、保存領域の保持期間登録、knowledge 文書                                                                             | P2     |
| WI-11 | 画面   | 相棒「進み具合」に候補一覧と同意状態を出す                                                                                                                               | P2     |
| WI-12 | ゲート | 各波の型検査・テスト・`pnpm check -- --scope pr`                                                                                                                         | 並走   |

## 4. 波と担当

| Wave | 項目                  | 担当モデル | ファイル所有権                                                                  | ゲート                     |
| ---- | --------------------- | ---------- | ------------------------------------------------------------------------------- | -------------------------- |
| 1    | WI-01, WI-02          | sonnet     | カタログ・スキーマ・`work-inventory.ts`・`libs/core/package.json` / index       | tsc + 単体テスト           |
| 2    | WI-03 / WI-04 / WI-06 | sonnet ×3  | それぞれの新規モジュールとテストのみ(共有 index は orchestrator がまとめて登録) | tsc + 単体テスト           |
| 2    | WI-05                 | opus       | 同意・観測モジュールとテスト                                                    | 同上 + 同意の否定系テスト  |
| 3    | WI-07 / WI-08 / WI-09 | sonnet ×3  | CLI / presence-studio ヒアリング / 昇格・実績                                   | tsc + テスト + CLI 実行    |
| 4    | WI-10 / WI-11         | sonnet     | 意図・保持期間・文書・画面                                                      | `pnpm check -- --scope pr` |

各波の後に orchestrator が差分をレビューし、テストを独立に再実行してから項目ごとにコミットする。

## 5. 非採用

- **常時の PC 監視**: 記録は本人が開始・停止する明示的な区間だけ。常駐の自動収集はしない。
- **LLM による手段の確定**: 提案は受けるが、確定は規則と人間。
- **棚卸し専用の新画面**: 共有レール(5 動詞)の中に置く(FD の方針を維持)。

## 6. 受入条件

| ID    | 条件                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------- |
| WI-02 | `effects: [money]` のステップは規則に関わらず `human` になる。スキーマ違反の記録は保存を拒否する  |
| WI-03 | 同じ繰り返し実行が 3 回以上ある業務に `kyberion_trace` 観測と頻度が付く                           |
| WI-04 | stub バックエンドで同じ入力から同じステップ列が出る。LLM の手段提案は規則で上書きされ、理由が残る |
| WI-05 | 同意なし・期限切れ・撤回済み・範囲外の記録は取り込みが拒否される。入力テキストは取り込まれない    |
| WI-06 | 順位が入力に対して決定的。校正で重みが変わると順位が変わる                                        |
| WI-07 | 全サブコマンドが `--json` で結果を返し、テナント外のパスに書かない                                |
| WI-08 | `/ask?mode=hearing&scenario=work_inventory` で棚卸し用の質問になり、確定で棚卸し記録ができる      |
| WI-09 | 昇格した候補に実績が記録され、予測との差が校正と学習候補に反映される                              |

## 7. リスクと対応

| リスク                       | 対応                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 個人の操作記録が組織に漏れる | 生の記録は personal 層に留め、本人確認済みの要約だけを昇格。監査ログ必須                 |
| 棚卸しが凍結手順になり壊れる | 判断を要するステップは semantic brief のまま。昇格は既存の scratch → pipeline の段を通す |
| 自己申告の頻度・時間が不正確 | ②③ の観測で確からしさを付け、順位に反映                                                  |
| 規則が現場に合わない         | 規則はカタログ(データ)。`human_override` を記録し、上書きが多い規則を学習候補にする      |

## 8. 実装状況

| ID        | 状態 | 備考            |
| --------- | ---- | --------------- |
| WI-01〜12 | 計画 | 2026-09-22 着手 |
