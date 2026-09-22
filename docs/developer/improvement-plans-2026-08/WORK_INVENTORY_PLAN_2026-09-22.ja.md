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

ブランチ `agent/work-inventory-20260922`(worktree `kyberion-work-inventory`)。

| ID    | 状態   | 備考                                                                                                                                                                                                                                                                                 |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WI-01 | DONE   | `work-inventory-taxonomy.json`(7 段・12 行為・5 手段・規則 7 本・行為/効果のキーワード・順位の既定値)と entry / taxonomy スキーマ。カタログ整合性チェックに登録                                                                                                                      |
| WI-02 | DONE   | `libs/core/work-inventory.ts`。規則は先勝ち、`money` / `irreversible` / `approval` は常に人間。`human_override` は保持、提案との食い違いは理由に両方残す                                                                                                                             |
| WI-03 | DONE   | `work-inventory-harvest.ts`。スパン名・時刻・状態・所要時間だけを読む。テナント間・個人スコープへの混入なし。`schedule` 宣言のあるパイプラインは `origin: scheduled` として候補提案から除外                                                                                          |
| WI-04 | DONE   | `work-inventory-decompose.ts`。モデル提案 → 規則で再判定。モデル不在・不正応答・時間切れは決定的なキーワード分解に落ちる                                                                                                                                                             |
| WI-05 | DONE   | `work-inventory-consent.ts` / `work-inventory-observation.ts`。同意は本人のみ・90 日以内・クリップボードと画面フレームは不可。要約は許可リスト方式(アプリ名・ホスト名・操作種別・回数)で本人の personal 層に保存し、本人確認後にだけテナントの業務へ。付与・撤回・取り込みは監査ログ |
| WI-06 | DONE   | `work-inventory-scoring.ts`。実測(利用ログ・記録)を自己申告より優先。校正は手段ごとの自動化可能割合を実績に寄せる(人間は固定 0)                                                                                                                                                      |
| WI-07 | DONE   | `pnpm inventory`(add / list / show / classify / override / status / harvest / consent / observe / candidates / promote / learn)。階層ガードのある読み書きは `pnpm tenant` と同じく `sovereign_concierge` の実行コンテキストで行う                                                    |
| WI-08 | DONE   | ヒアリングのシナリオをカタログ化(`hearing-scenarios.json`)。`/ask?mode=hearing&scenario=work_inventory` で棚卸しの 8 項目を聞き、確定で業務記録を保存                                                                                                                                |
| WI-09 | DONE   | `work-inventory-promotion.ts`。mission への昇格はヒアリングと同じ統治された hand-off(人間の `decided_by`、alignment gate)。実績計測 → 校正 → 組織の学習候補キュー                                                                                                                    |
| WI-10 | 進行中 | 標準意図・保持期間・knowledge 文書                                                                                                                                                                                                                                                   |
| WI-11 | 進行中 | 「進み具合」の候補パネル                                                                                                                                                                                                                                                             |
| WI-12 | 進行中 | 波ごとの tsc / テストは実施済み。PR 前の `pnpm check -- --scope pr` は最後に実施                                                                                                                                                                                                     |

### 発見・修正した欠陥

- 規則の穴: API のある業務システムへの画面操作、API のないシステムでの受信・連絡が「人間」に落ちていた → 規則を広げた(Wave 1 レビュー)。
- 観測要約の ID に「要約した日」が入り、翌日に同じ記録を要約し直すと重複して回数が二重計上される → 記録日に変更(Wave 2 レビュー)。
- 定期実行の判定をダイジェスト文字列の中身で行っていた → 観測記録に `origin` 欄を追加(Wave 3 レビュー)。
- CLI が実行コンテキストなしで階層ガード付きの領域を読み書きして拒否されていた → `pnpm tenant` と同じ統治された実行コンテキストで包んだ(Wave 3 レビュー)。
- 業務 ID が ASCII の見出しだけで作られ、「経費精算 Excel」と「売上集計 Excel」が同じ ID になって黙って上書きされていた → ID に「見出し・スコープ・作成時刻」のハッシュ 8 桁を付け、新規作成は上書きを拒む `mode: 'create'` で保存(CLI `add`、`harvest --suggest` は既存を飛ばす、ヒアリングの引き渡しは 409)(独立レビュー)。
- mission への昇格で、別スコープの同じ業務 ID が既存 mission を「作成済み」として再利用していた → mission ID にスコープを含むハッシュを入れ、既存 mission は brief の `source`(業務 ID・テナント)と tier が一致しなければ `MISSION_ID_CONFLICT`(独立レビュー)。
- 取り込みでテナントを指定しても、テナントを持たない ad-hoc 台帳・未処理意図が混ざっていた → テナントなしのトレースと同じく、個人スコープか `includeUnscoped` のときだけ含める(独立レビュー)。
- 行為の既定候補で埋めた結び付け(例 `browser-actuator:computer_interaction`)が汎用の実行記録すべてと照合されていた → 埋めた結び付けに `inferred: true` を付け、照合には使わない(表示・昇格の手がかりとしては残す)(独立レビュー)。
- 昇格後の実績に昇格前の実行や台帳の累計が混ざっていた → 昇格済みの業務ごとに `since = max(昇格時刻, 現在 − 期間)` で集め直し、開始が昇格前の集計と累計系(ad-hoc 台帳・未処理意図)は数えない(独立レビュー)。
- CLI の `consent` / `observe` は `--member X --decided-by user:X` で誰にでもなれた → 端末 CLI はこの機械の持ち主(loopback と同じ信頼)として動き、`--member` / `--decided-by` は持ち主以外を拒否。持ち主が未登録なら onboarding を案内(独立レビュー)。
- 人間の上書きで money / irreversible / approval のステップを自動手段に下げられた → 分類規則側で拒否し理由に記録、CLI `override` は事前に拒否。対象の効果はタクソノミーの `forced_human_effects` から読む(独立レビュー)。
- 校正が「実行の成功率」と「予測の自動化割合」という別の量を比べ、人と API の混在業務で `api` が 1 に寄っていた → 実績を「予測 × 成功率」と定義し、自動実行が失敗したときだけ下げる。ギャップの学習信号も同じ定義(独立レビュー)。
- 所要時間の実測にトレースの所要時間(機械の時間)を使っていた → 人の操作時間であるデスクトップ・ブラウザ記録だけを使う(独立レビュー)。
- core のテストが `node:fs` を直接使い、fs 例外境界・import 基準線のテストが落ちていた → secure-io の fixture に置き換え、基準線に足していた 3 行を削除(独立レビュー)。

### 既知の残件

- **トレースの衛生**: 2026-08-25〜28 に空の `code-actuator:pipeline` などが 1 日 2〜3 千件記録されている。テスト実行が本番のトレースに書き込んだとみられ、需要推定を歪める。トレースの出所の区別(テスト / 定期 / 人)は別件で対応する。
- デスクトップ記録にはステップごとの時刻がないため、デスクトップ由来の所要時間は取れない(ブラウザ記録のみ)。
- ヒアリング画面の見出しは両シナリオ共通のまま(シナリオ別の見出し・説明の表示は後続)。
- 持ち主以外のメンバーの同意・観測は、そのメンバー自身が認証された画面(トークン経由の surface)で行う必要がある。端末 CLI は持ち主専用で、他メンバー向けの同意導線は未実装。
- この修正より前に保存した業務の結び付けには `inferred` 印がないため、既定候補で埋めた結び付けがまだ照合に使われる(既存記録の移行は未対応)。

## 9. 続き(WI-13〜17、ミッション `MSN-WORK-INVENTORY-FOLLOWUPS-20260922`)

PR #761 のマージ後、§8 の既知の残件を片付ける。調査で分かった原因:

- **トレースの混入**: vitest を本番チェックアウトで実行すると、アクチュエータのトレース(`code-actuator:pipeline`、`media-actuator:pipeline`、`browser-pipeline:*`、`meeting-actuator:speak`)が `active/shared/logs/traces/` に書かれる。2026-08-25 の `110d028d4`(トレース追記を foundation の `appendJsonLine` に移行)以降、テストの secure-io モックが効かなくなった。media / speak / browser は 2026-09-21 時点でも混入が続いている。
- **CodeQL `js/shell-command-constructed-from-input`**(リポジトリ全体で未解決 686 件): シンクは `secure-io.ts` の `safeExecResult`(`spawnSync`)と `safeExec`(`execFileSync`)の 2 箇所だけ。どちらも `shell: false` を明示しておらず、オプションが `any` 型。

| ID    | 区分 | 内容                                                                                                                                                                                                                     | 優先度 |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| WI-13 | 衛生 | テストプロセスからは本番トレースに書かない(明示の出力先指定か専用の環境変数があるときだけ書く)。トレースに `metadata.origin`(test / ci / scheduled / agent / interactive)を付け、業務棚卸しの収集は test / ci を除外する | P1     |
| WI-14 | 安全 | `safeExec` / `safeExecResult` に `shell: false` を明示し、オプションを型付きにして `shell` キーを拒否する                                                                                                                | P1     |
| WI-15 | 同意 | 秘書室の「設定」に「PC 操作の記録」を追加。ログイン中のメンバー本人が、自分の同意の付与・撤回と、確認待ち要約の確認・破棄・業務への取り込みを行う(本人は必ずサーバー側で解決)                                            | P1     |
| WI-16 | 保持 | 保持期間カタログに状態つき規則を追加し、janitor が「確認されないまま 30 日を過ぎた要約」と「破棄後 30 日を過ぎた要約」を監査つきで削除する                                                                               | P2     |
| WI-17 | 移行 | 既存の業務記録で、行為の既定候補と一致する結び付けに `inferred` 印を付ける移行(`pnpm inventory migrate`、空実行つき)                                                                                                     | P2     |

| Wave | 項目          | 担当モデル | ファイル所有権                                                                                |
| ---- | ------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1    | WI-13 + WI-17 | sonnet     | `libs/core/src/trace.ts`・env registry・`work-inventory-harvest.ts`・`work-inventory.ts`・CLI |
| 1    | WI-14         | sonnet     | `libs/core/secure-io.ts` と呼び出し側の型                                                     |
| 1    | WI-15         | sonnet     | `presence/displays/concierge/**`・語彙                                                        |
| 1    | WI-16         | sonnet     | `storage-janitor.ts`・保持期間カタログとスキーマ                                              |

受入条件:

- WI-13: vitest 実行中の `persistTrace` は既定で本番ディレクトリに書かない。`origin` は環境から決定的に付く。test / ci 由来の信号は収集されない。
- WI-14: 既存の呼び出しがすべて通り、`shell` を渡すと例外になる。PR の CodeQL で該当ルールの新規アラートが出ない。
- WI-15: 他人の同意・要約は見えず操作できない(本人は常にサーバー側で解決)。匿名の閲覧者には出さない。
- WI-16: 確認済みの要約と有効な同意は消えない。削除は監査に残る。
- WI-17: 空実行で対象件数を表示し、実行後に既定候補の結び付けが照合に使われない。

レビューで修正した点:

- WI-17: 移行が、人が意図して既定候補と同じ結び付けを設定した業務まで `inferred` にしていた。`INFERRED_BINDING_TAGGING_SINCE`(PR #761 のマージ時刻 `2026-09-22T10:18:05Z`)より前に作られた業務だけを移行の対象にし、それ以降の業務では明示の結び付けに `inferred: false` を付ける(`applyClassification` と、使用信号から作る下書き)。
- WI-13(origin): `MISSION_ROLE` は `pnpm pipeline` や `withExecutionContext` でも付くため、人が始めた実行が `agent` になっていた。`agent` は `KYBERION_NHI_ID` / `KYBERION_AGENT_ID` があるときだけにした。
- WI-13(scheduled): Chronos の実行が `scheduled` にならなかった。トリガー実行器が cron 配信ごとに張る非同期スコープ(`withTriggerCorrelation`)を `deriveTraceOrigin` が読むようにした(実行が重なっても混ざらない)。環境変数 `KYBERION_RUN_ORIGIN` を登録し、baseline-check が起動する janitor に `scheduled` を渡す。収集では、数えたトレースの半分以上が `scheduled` のときだけ信号を `scheduled` にする。
- WI-16: `review_required` の下で状態つき規則が削除することを、唯一の明示的な例外としてコードとカタログの注記に書いた。削除の直前にファイルを読み直し、状態と経過日数がまだ条件に合うときだけ消す。
- WI-15: ループバックの閲覧者に本人の個人の業務一覧を出すのは意図した判断(所有者本人、presence-studio と同じ規則)だとコメントに残した。同意の日数は 1 以上・上限以下の整数だけを受け付け、大きすぎる値は 500 ではなく 400 を返す。

## 10. 続き 2(WI-18〜19、ミッション `MSN-WI-CONSENT-CODEQL-20260922`)

PR #762 マージ後の判断(2026-09-22、利用者):

| ID    | 区分 | 内容                                                                                                                                                                                                                                                               | 優先度 |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| WI-18 | 同意 | 秘書室の「設定 › PC 操作の記録」で、閲覧専用(viewer)ロールのメンバーも**本人の**同意の付与・撤回と、本人の要約の確認・破棄だけは書き込めるようにする。ほかの自己設定の書き込み権限は変えない。業務への取り込み(テナントの業務記録の更新)は従来どおり管理権限が必要 | P1     |
| WI-19 | 安全 | CodeQL `js/shell-command-constructed-from-input`(main で未解決 686 件)の原因を CodeQL CLI で手元で再現・検証してから直す。`shell: false` の明示(WI-14)では件数が変わらなかった                                                                                     | P2     |

WI-19 の仮説: secure-io の汎用ヘルパー(`safeExec` / `safeExecResult`)を経由して `sh -c` / `powershell` などを起動する呼び出し元があるため、CodeQL がヘルパーの引数全体をシェルに渡りうるとみなしている。シェルを起動する呼び出しを専用のヘルパーに分ければ、汎用ヘルパーの引数はシェル扱いされなくなる。PR 上の CodeQL は変更箇所しか報告しないため、効果は手元の CodeQL CLI で全体解析して確かめる。
