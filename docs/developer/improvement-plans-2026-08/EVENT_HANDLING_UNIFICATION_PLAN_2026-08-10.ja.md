---
title: EVENT HANDLING UNIFICATION PLAN 2026 08 10
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: active
---

# イベント処理統一計画(EV-01〜10)

> **作成日**: 2026-08-10
> **根拠**: イベント関連の read-only 全経路調査 — `trigger-runner` / `pipeline-scheduler` / `generation-scheduler` / `worker-event-stream` / `mission-orchestration-events` / `mission-task-events` / `agent-collaboration-*` / `nerve-bridge` / `sensory-memory` / `reflex-engine` / surface ingress / `operator-notifications` / `storage-retention-catalog`
> **位置づけ**: [QM_ADOPTION_PLAN](./QM_ADOPTION_PLAN_2026-08-01.ja.md) QM-02(トリガ実行経路の単一化と権限非昇格)の **API は完成・配線が未完** という状態を閉じる後続計画。[LIFECYCLE_SMOOTHNESS_PLAN](./LIFECYCLE_SMOOTHNESS_PLAN_2026-08-08.ja.md) LC-01(スケジューラ常駐化)の兄弟。
> **前提**: 単一ホスト・ローカルファーストを維持する。外部メッセージブローカ(Redis / NATS / Kafka)や DB 一元化は導入しない(§5 非採用)。**イベント系統を 1 本に畳むことは目的ではない** — 目的は「発火するイベントは必ず governed な関門を通る」と「どの系統も宣言と実配線が一致している」の 2 点。

## 1. 現状 — イベントは 1 本ではなく 5 系統

| 系統                             | 発火源                                                     | 正本の置き場                                                                                                    | 実装                                                                               |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ① **トリガ層**(外→実行の起動)    | cron / process watch / surface wake                        | `active/shared/runtime/trigger-deliveries.jsonl`                                                                | `libs/core/trigger-runner.ts`                                                      |
| ② **実行内イベント**(プロセス内) | turn / step / phase / approval / notification              | プロセス内 SPMC + `active/shared/logs/worker-events/**.jsonl`                                                   | `libs/core/worker-event-stream.ts`                                                 |
| ③ **ミッション/タスクイベント**  | orchestration 要求、task 発行〜受入                        | `active/shared/coordination/orchestration/events/*.json`、`active/shared/observability/mission-control/*.jsonl` | `mission-orchestration-events.ts` / `mission-task-events.ts`                       |
| ④ **神経系(KANS)刺激バス**       | 任意プロセスからの `NerveMessage`                          | `presence/bridge/runtime/stimuli.jsonl`                                                                         | `nerve-bridge.ts` / `sensory-memory.ts` / `shared-nerve/reflex-engine.ts`          |
| ⑤ **surface 入出力**             | Slack / iMessage / Telegram / Discord / Chronos / Presence | `active/shared/coordination/channels/{surface}/inbox\|outbox`、`active/shared/observability/channels/**`        | `channel-surface.ts` / `surface-ingress-contract.ts` / `operator-notifications.ts` |

読み取り側は ③ の 3 本(`task-events` / `orchestration-events` / `agent-runtime-supervisor-events`)のみ `agent-collaboration-projection.ts` が読み取りモデルに畳み込む。

### 1.1 ガバナンス強度の非対称

| 保証                          | ①   | ②              | ③           | ④   | ⑤                      |
| ----------------------------- | --- | -------------- | ----------- | --- | ---------------------- |
| 冪等キー / 重複抑止           | ✅  | —(観測専用)    | —           | ❌  | 通知側のみ(10分dedupe) |
| 権限非昇格チェック            | ✅  | —              | —           | ❌  | ロール別 append        |
| リーダーリース / 二重起動防止 | ✅  | —              | —           | ❌  | —                      |
| 監査チェーン記録              | ✅  | ❌(jsonl のみ) | ✅(journal) | ❌  | ✅(decision/why)       |
| 未信頼入力スクリーニング      | —   | —              | —           | ❌  | ✅(QM-04)              |
| スキーマ検証                  | —   | ✅(zod strict) | 型のみ      | ❌  | 型のみ                 |

**問題の構造**: QM-02 で ① に強い関門を作ったが、**実際にそこを通っている発火源は cron(chronos_daemon)1 系統だけ**。他の発火源(generation schedule / process watch / wake / reflex)は関門を迂回するか、そもそも配線されていない。結果として「トリガは単一化済み」という宣言と実配線が乖離している。

## 2. 改善項目一覧

| ID    | タイトル                                                      | 優先度 | 規模 | 依存                         |
| ----- | ------------------------------------------------------------- | ------ | ---- | ---------------------------- |
| EV-01 | generation-scheduler の TriggerRunner 統合と catch-up 統一    | **P1** | M    | QM-02 後続                   |
| EV-02 | process watch / wake トリガの配線完遂または明示撤去           | **P1** | S    | QM-02 後続                   |
| EV-03 | reflex 経路の実配線 + governed 化、または正直な撤去           | **P1** | M    | EV-02 / EV-04                |
| EV-04 | nerve-bridge テール読取の堅牢化と TTL 執行                    | **P1** | S    | なし                         |
| EV-05 | スケジュールデーモンの watchdog 監視対象化                    | **P1** | S    | LC-01 後続                   |
| EV-06 | イベントストアの保持・ローテーション統一                      | **P1** | S    | AL-04(retention catalog)後続 |
| EV-07 | イベント語彙の単一正本化と系統間マッピング表                  | P2     | M    | EV-01〜03 後                 |
| EV-08 | クロスプロセス購読の単一手段化(jsonl tail アダプタ)           | P2     | M    | EV-06 後                     |
| EV-09 | トリガ → 成果の end-to-end 相関(correlation/causation 必須化) | P2     | M    | EV-07 後                     |
| EV-10 | イベント正直性テスト(宣言 vs 実配線の突合 checker)            | P2     | S    | EV-01〜03 後                 |

---

### EV-01: generation-scheduler の TriggerRunner 統合と catch-up 統一(P1 / M)

**現状**: cron 経路が二重系になっている。

- `scripts/chronos_daemon.ts` — pipeline schedule。TriggerRunner 経由(冪等キー `cron:{id}:{分}`、`chronos_gateway` authority、leader lease、runLock、監査あり)
- `scripts/run_generation_schedule_daemon.ts` → `run_generation_schedule.ts --action tick` — media generation schedule。**60 秒ごとに子プロセスを spawn するだけ**で、`isGenerationScheduleDue()`(`libs/core/generation-scheduler.ts:77`)が独自に due 判定し、そのまま submit する

**欠落しているもの**(generation 側):

1. 冪等キー / delivery receipt — 同一分に 2 プロセスが tick すれば二重投入しうる
2. authority スナップショットと非昇格チェック
3. leader lease — 複数ホスト/複数プロセスでの排他がない
4. 監査チェーン記録
5. **取りこぼし補償** — `pipeline-scheduler` は `hasMissedCronOccurrence()`(`libs/core/src/pipeline-scheduler.ts:98`)で停止中に過ぎた発火を次回 tick で回収するが、generation 側は「今この分が cron にマッチするか」しか見ないため、デーモン停止中の発火は**恒久的に消える**

**実装**:

1. `generation-scheduler.ts` の `tickGenerationSchedule` を `TriggerRunner.run({ source: 'cron', idempotencyKey: 'gen:{schedule_id}:{分}' , createdBy: <governed role> })` でラップする。authority role は既存 registry から選ぶ(新設が必要なら `authority-roles/` に登録儀式を通す)
2. `run_generation_schedule_daemon.ts` の tick を `withTriggerLeaderLease('generation-schedule-daemon', …)` で包む
3. due 判定の catch-up ロジックを `src/cron-utils.ts` 側に `hasMissedCronOccurrence` として移し、pipeline / generation の両スケジューラが同一実装を共有する(現在 pipeline-scheduler にのみ private 実装)
4. `markGenerationScheduleSubmitted` を runLock 相当(token + TTL)に置き換え、完了時に token 照合で解放する

**受入条件**: 同一分の二重 tick が 1 回しか submit しない回帰テスト / デーモン停止を模した catch-up テスト(pipeline・generation の両方で同一表明) / 権限不正な tick が `rejected` レシートになるテストが CI にある。

---

### EV-02: process watch / wake トリガの配線完遂または明示撤去(P1 / S)

**現状**: `armTriggerWatch()`(`libs/core/trigger-runner.ts:470`)と `runWakeTrigger()`(`:506`)は実装・テスト済みだが、**production の呼び出し元が存在しない**(grep 上、参照は `trigger-runner.ts` 自身とテストのみ)。`managed-process.ts` の `armWatch` も同様に本体外の呼び出し元がない。

`pipelines/health-degradation-watch.json` / `pipelines/tenant-drift-watch.json` は名前が "watch" だが実体は cron(`30 * * * *` / `15 5 * * *`)であり、process watch ではない。

**判断が必要**: `TriggerSource = 'cron' | 'watch' | 'wake'` の 3 値のうち 2 つがデッド宣言になっている。取りうる選択は 2 つで、**どちらかを選んで宣言と実装を一致させる**ことがこの項目のゴール。

- **(A) 配線する** — 少なくとも 1 つの実需に接続する。候補: ①`agent-runtime-supervisor` が管理する長寿命プロセスの `exited` / `quiet` を watch トリガ化し、自動再起動を governed 経路に載せる ②surface bridge(Slack/iMessage)の再接続を wake トリガ化する
- **(B) 撤去する** — `TriggerSource` を `'cron'` のみに縮退させ、`armTriggerWatch` / `runWakeTrigger` を削除。QM_ADOPTION_PLAN の QM-02 記述を「cron 経路の単一化」に訂正する

**推奨は (A) の最小配線**。`daemon_watchdog.ts` は現在ハートビート方式(`DEFAULT_DAEMONS = ['chronos-daemon', 'agent-runtime-supervisor-daemon']`)で異常を**検知はするが再起動はしない**(推奨アクションを ops alert に書くのみ)。ここを watch トリガ + 承認/自動の二段(`autonomous-ops-gate` の `auto`/`notify`/`approve` 判定)に載せると、デッド宣言の解消と LC-01 の常駐化要件が同時に埋まる。

**受入条件**: `TriggerSource` の全値に production 呼び出し元があること(または存在しない値が型から消えていること)を EV-10 の checker が機械検証する。

---

### EV-03: reflex 経路の実配線 + governed 化、または正直な撤去(P1 / M)

**現状**: `docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md` は「反射 ADF(`knowledge/procedures/reflexes/*.adf.json`)で定型反応をコードなしで定義できる」と説明しているが、`reflexEngine.setDispatcher()` の呼び出しは**テストのみ**。dispatcher 未設定時は warn して no-op(`libs/shared-nerve/src/reflex-engine.ts:81-84`)なので、**反射は現状 1 件も発火しない**。

さらに、仮に配線しても現状の reflex 経路には以下がない:

- 冪等性(同一刺激に複数回マッチすれば複数回 actuator を叩く)
- レート制限(刺激が連続すれば actuator も連続実行)
- 権限チェック(`action.actuator` / `action.command` を無検査で dispatcher に渡す)
- 監査記録

加えて `executeReaction` は `{{payload}}` を **JSON 文字列に対する文字列置換**で埋め込んでから `JSON.parse` し直す(`:88-91`)。payload が未信頼入力(Slack 由来など)の場合、引用符やエスケープを含む payload が構造を壊す/意図しないフィールドを注入しうる。**⑤ の入力スクリーニング(QM-04)を通った payload が、④ 経由で ⑤ の外に出る**経路になっている点が構造的な穴。

**実装**:

1. 方針決定を先に行う。**(A) 配線する**なら 2〜5 を実施。**(B) 撤去する**なら `reflex-engine.ts` と reflex ADF ディレクトリを削除し、AUTONOMY_SYSTEM_GUIDE.md の §2「反射設計図」を削除する(ドキュメント正直性)
2. (A) の場合: dispatcher を actuator-op-registry 経由の governed dispatch に bind し、`action.actuator`/`command` を registry 実在チェック + `restricted-action-kinds-policy` 突合にかける
3. reflex 発火を `TriggerRunner.run({ source: 'wake', idempotencyKey: 'reflex:{reflex_id}:{stimulus_id}' })` 経由にする(EV-02 の wake 実需にもなる)
4. `{{payload}}` の展開を文字列置換から**構造的置換**(パース済みオブジェクトのプレースホルダノードを値で差し替え)に変更する
5. reflex に乗る payload は `filterTaintedForModelContext` / provenance ラベルを維持したまま渡す

**受入条件**: reflex が本当に発火する E2E テスト(または撤去されコードが存在しないこと) / 引用符・改行・`}` を含む payload で構造破壊が起きない回帰テスト / 同一刺激の二重発火がないテスト。

---

### EV-04: nerve-bridge テール読取の堅牢化と TTL 執行(P1 / S)

**現状**: `listenToNerve()`(`libs/core/nerve-bridge.ts:80`)は 1 秒ポーリング + **ファイルサイズ差分**で新着を読む。

```
if (stats.size > lastSize) { …読む…; lastSize = stats.size; }
```

- `stimuli.jsonl` がローテーション/切り詰めされると `lastSize` が実サイズを超え、**以降の追記を恒久的に読み落とす**(`stats.size > lastSize` が二度と成立しない)
- 追記が 1 秒に跨って部分書き込みされた場合、行途中で切れた断片を `JSON.parse` して warn 破棄する(次周回で残りだけ読むため、そのメッセージは失われる)
- `metadata.ttl: 60` は**宣言だけで執行ロジックがない**。`sensoryMemory.hasActiveContext(keyword, windowMs)` は呼び出し側が渡す窓のみを見るため、TTL 切れの刺激も `dynamic-permission-guard` の判定材料になりうる

**実装**:

1. `lastSize` に加えて **inode(または `safeStat` の `ino`)と先頭 N バイトの指紋**を保持し、不一致なら「ローテーションされた」と判定して先頭から読み直す(`stats.size < lastSize` も同じ扱い)
2. 未完結行(改行で終わっていない末尾)をバッファに残し、次周回で結合してからパースする
3. `ttl` を執行する: `loadRecentStimuli` / `SensoryMemory.hydrate` で `ts + ttl` を過ぎた刺激を除外する。TTL を持たない旧レコードは既定 TTL を適用
4. `dynamic-permission-guard` が参照する刺激は TTL 執行後のものに限る(**権限を開放する材料が期限切れであってはならない**)

**受入条件**: ファイル切り詰め後に新着が読めるテスト / 部分書き込み行が次周回で正しく復元されるテスト / TTL 超過刺激が `hasActiveContext` に効かないテスト。

---

### EV-05: スケジュールデーモンの watchdog 監視対象化(P1 / S)

**現状**: `scripts/daemon_watchdog.ts` の `DEFAULT_DAEMONS` は `['chronos-daemon', 'agent-runtime-supervisor-daemon']` のみ。**generation schedule daemon はハートビートも記録しておらず、監視対象でもない**。止まっても誰も気づかず、EV-01 の catch-up がない現状では停止中の発火が全て失われる。

**実装**:

1. `run_generation_schedule_daemon.ts` に `recordDaemonHeartbeat('generation-schedule-daemon', …)` を追加(chronos と同じ形: starting / running / error)
2. `DEFAULT_DAEMONS` に追加
3. surface 常駐(`surfaces/*.json` の `enabled: true` なもの)についても、`surface_runtime --action status` の結果を watchdog が読むか、各 bridge がハートビートを出すかを決めて配線する
4. watchdog の推奨アクション文字列にとどめず、`autonomous-ops-gate` 判定で `auto` なら再起動まで行うかを EV-02(A) と合わせて決める

**受入条件**: `pnpm daemon:watchdog -- --json` の出力に全常駐プロセスが現れ、意図的に 1 つ停止させると unhealthy として検出されるテスト。

---

### EV-06: イベントストアの保持・ローテーション統一(P1 / S)

**現状**: 追記専用ストアごとに保持ポリシーがバラバラで、**一部は無制限に成長する**。

| ストア                                                                                             | 現状の上限                                           | retention catalog                                  |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `active/shared/runtime/trigger-deliveries.jsonl`                                                   | 自前 compaction(4MB / 上限 5MB)                      | 対象外(ファイル直置き)                             |
| `active/shared/logs/worker-events/**.jsonl`                                                        | —(日次ファイル分割のみ)                              | ✅ `active/shared/logs` 30日                       |
| `active/shared/observability/**.jsonl`(task-events / orchestration-events / channels / ops-alerts) | **なし**                                             | ❌ **未登録**                                      |
| `active/shared/coordination/orchestration/events/*.json`                                           | **なし**(1 イベント 1 ファイル、消費後も残る)        | ❌ **未登録**                                      |
| `presence/bridge/runtime/stimuli.jsonl`                                                            | 読み側が直近 5000 件のみ参照(**ファイルは無限成長**) | ❌ **未登録**(`presence/` 配下は catalog の対象外) |
| `active/shared/runtime/security/quarantine.jsonl`                                                  | 32KB/レコード + 5MB ローテーション(QM-04)            | —                                                  |

`storage-retention-catalog.json` の説明は「declared here 以外は janitor が削除しない = 静かな永久保持にはしない(uncovered として報告する)」と述べているが、`active/shared/observability/` と `presence/bridge/runtime/` は janitor のスキャン対象外のため**報告にも出ない**。

**実装**:

1. `active/shared/observability/` 配下の各サブツリーを retention catalog に登録する(`task-events`/`orchestration-events` は監査性が要るので `ttl_days: 90` + `audit: true`、`channels/**/events.jsonl` は 30日、`ops-alerts.jsonl` は 90日 が出発点)
2. `coordination/orchestration/events/*.json` に「消費済みイベントのアーカイブ」規則を追加(worker 完了時に `archive/` へ移すか、journal に統合済みなら TTL 削除)
3. `presence/bridge/runtime/` を janitor のスキャン範囲に含めるか、`stimuli.jsonl` 側に quarantine.jsonl と同型のサイズローテーション(5MB)を実装する。**EV-04 のローテーション検知はこの前提**
4. `trigger-deliveries.jsonl` の compaction を catalog に「self-managed」として明記し、janitor の uncovered 報告から外す

**受入条件**: `pnpm pipeline --input pipelines/storage-janitor.json` の uncovered 報告にイベントストアが残らない / 30日分の合成データで各ストアが上限内に収まる回帰テスト。

---

### EV-07: イベント語彙の単一正本化と系統間マッピング表(P2 / M)

**現状**: イベント型の語彙が 5 箇所に分散し、正本がない。

- `WORKER_EVENT_TYPES`(19 値、zod enum) — `worker-event-stream.ts:18`
- `MissionOrchestrationEventType`(9 値) — `mission-orchestration-events.ts:9`
- `MissionTaskEventType`(6 値) — `mission-task-events.ts:8`
- `CollaborationKind`(14 値) + `CollaborationSource`(8 値) — `agent-collaboration-events.ts:6`
- `OperatorEvent`(6 値) — `operator-notifications.ts:24`
- `ManagedProcessWatchEventKind`(5 値) — `managed-process.ts:30`

変換は `collaborationKindFromEventType()`(`agent-collaboration-events.ts:130`)の**文字列 `includes` による推測 20 行**が唯一の橋渡しで、順序依存かつ silent に `'unknown'` へ落ちる。新しいイベント型を足しても、この関数を更新しなければ UI 上は "unknown" として静かに劣化する。

**実装**:

1. QM-09 の gap-phase で採った「**コードが registry**」方式を踏襲し、`libs/core/event-vocabulary.ts` に全系統の語彙と**明示的なマッピング表**(`Record<SourceEventType, CollaborationKind>` を型で網羅性強制)を置く
2. `collaborationKindFromEventType` を推測から表引きに置き換える。表に無い値はコンパイルエラー(`Record` 網羅性)にする
3. `'unknown'` に落ちた実績を `status_flags` に上げる仕組みは既にある(`CollaborationStatusFlag = 'unknown_event'`)ため、表引き移行後は**ゼロであることを CI で表明**する

**受入条件**: 新しいイベント型を 1 つ足すとマッピング未定義でビルドが落ちること / 既存の全イベント型に対し `unknown` が返らないテスト。

---

### EV-08: クロスプロセス購読の単一手段化(P2 / M)

**現状**: `WorkerEventStream` は**プロセス内 SPMC のみ**。別プロセスから購読する統一手段がなく、消費側はそれぞれ独自に jsonl を読む(`agent-collaboration-projection` は 3 本を毎回全読み、`nerve-bridge` は独自のサイズ差分ポーリング、terminal-hud は `use-poll-watch` で独自ポーリング)。同じ「追記ファイルを追尾する」問題を 3 箇所で別々に、かつ EV-04 と同じ欠陥を抱えたまま解いている。

**実装**:

1. `libs/core/jsonl-tail.ts` を新設 — inode/指紋によるローテーション検知、未完結行バッファ、カーソル永続化、`AbortSignal` 対応を 1 箇所に実装(EV-04 の修正はここへ吸収)
2. `attachJsonlRecorder` の対になる `subscribeJsonl(filePath) → WorkerEventStream` アダプタを提供し、別プロセスが「ファイルを読む」のではなく「ストリームを購読する」形に統一
3. `nerve-bridge.listenToNerve` / `agent-collaboration-projection` の再読み込み / terminal-hud のポーリングを順次このアダプタへ寄せる

**受入条件**: 3 つの消費側が同一アダプタを使い、ローテーション/部分書き込みのテストがアダプタ 1 箇所に集約されている。

---

### EV-09: トリガ → 成果の end-to-end 相関(P2 / M)

**現状**: `correlation_id` / `causation_id` を持つのは ③ と ⑤ の一部だけ。① のトリガレシートは `idempotencyKey` を correlation として監査に書くが(`trigger-runner.ts:285`)、そこから起動した pipeline の trace / mission event / 成果物 / 通知には伝播しない。「昨夜の cron が何を生み、なぜ通知が来たのか」を追うには複数ファイルを手で突き合わせる必要がある。

**実装**:

1. `withExecutionContextAsync` の実行コンテキストに `trigger_delivery_id` を載せ、TriggerRunner の deliver 内で起動する全処理が自動的に継承する(chronos は既に `runId = deliveryId` を渡しているのでその一般化)
2. `WorkerEventStream` の `source` に `trigger_delivery_id?` を追加(zod strict なのでスキーマ更新が必要)
3. `operator-notifications` の `correlation_id` にも同 ID を通し、通知から発火元まで 1 ホップで辿れるようにする
4. Chronos TraceViewer に「このトリガ配信から生まれたイベント一覧」ビューを追加(QM-09 の gap 内訳表示と同じ場所)

**受入条件**: 1 回の cron 発火に対し、trigger receipt → pipeline trace → worker events → 通知 が同一 ID で串刺し検索できる E2E テスト。

---

### EV-10: イベント正直性テスト(宣言 vs 実配線の突合 checker)(P2 / S)

**現状**: 本計画で見つかった問題の大半は「**宣言はあるが配線がない**」という同型の欠陥である(watch/wake トリガ、reflex dispatcher、AUTONOMY_SYSTEM_GUIDE の記述、generation daemon の監視)。QM-10 で導入したドキュメント正直性テストと同じ手法をイベント層に適用すれば、再発を機械的に防げる。

**実装**: `scripts/check_event_wiring.ts` を新設し、`pnpm validate` に登録する。検証項目:

1. `TriggerSource` の全値に production 呼び出し元がある(テスト・自ファイルを除く)
2. `WORKER_EVENT_TYPES` の全値に emit 元がある
3. EV-07 のマッピング表が全ソースイベント型を網羅している
4. `knowledge/procedures/reflexes/*.adf.json` が存在するなら reflex dispatcher が bind されている
5. `surfaces/*.json` で `enabled: true` かつ常駐のものが watchdog の監視対象に入っている
6. AUTONOMY_SYSTEM_GUIDE.md / CAPABILITIES_GUIDE.md がイベント機能に言及する箇所が、実配線の存在するものだけである

**受入条件**: 現在の欠陥(watch/wake 未配線、reflex 未 bind、generation daemon 未監視)を checker が**赤で検出**することを先に確認してから、EV-01〜05 で緑にする。

---

## 4. 実施バッチとミッションゲート判定

| バッチ | 内容                            | 狙い                                                            |
| ------ | ------------------------------- | --------------------------------------------------------------- |
| ①      | EV-10(checker を先に赤で立てる) | 以降の完了判定を機械化する。単独で小さく、先行実施が有効        |
| ②      | EV-04 + EV-06                   | データ損失/無限成長の止血。他項目に依存しない                   |
| ③      | EV-01 + EV-05                   | 失われている発火の回復(catch-up + 監視)。運用影響が最大         |
| ④      | EV-02 + EV-03                   | デッド宣言の解消。**先に (A) 配線 / (B) 撤去 の方針決定が必要** |
| ⑤      | EV-07 + EV-08 + EV-09           | 観測の質。①〜④ が終わってからで良い                             |

**ミッションゲート判定**: 5 以上のアーティファクトに跨り、再実行/変種があり、同一パターン(トリガ関門への配線)の反復がある — **累積トリガ 2 条件以上が成立するため、ミッション + pipeline 経由で実施する**([work-scope-policy.json](../../../knowledge/product/governance/work-scope-policy.json))。バッチ間は独立性が高く、別ミッションに分割してよい。バッチ④ のみ**方針決定(A/B)が先行必須**で、これは alignment フェーズの合意事項として扱う。

## 5. 非採用

| 案                                           | 不採用の理由                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 外部メッセージブローカ(Redis / NATS / Kafka) | 単一ホスト・ローカルファーストの前提を崩す。現状の追記 jsonl + ファイルロック + 監査チェーンで成立しており、移行コストが利益を上回る |
| 5 系統を単一イベントバスに統合               | 系統ごとに要求(プロセス内低遅延 / 永続キュー / 監査必須 / 疎結合刺激)が異なる。**統合ではなく、関門の共有と語彙の正本化**で足りる    |
| イベントストアの DB(SQLite)化                | QM_ADOPTION_PLAN §4 の判断を踏襲。パターン(冪等キー・リーストークン・契約テスト)だけを採る                                           |
| 全イベントへの署名付与                       | `a2a-envelope-signature` が必要な境界(プロセス間 A2A)には既にある。ローカル追記ストアには過剰                                        |

## 6. 検証コマンド

```bash
pnpm vitest run libs/core/trigger-runner.test.ts                # ① トリガ関門
pnpm vitest run libs/core/src/pipeline-scheduler.test.ts        # cron due 判定 / catch-up
pnpm vitest run libs/core/managed-process.watch.test.ts         # process watch
pnpm vitest run libs/shared-nerve/src/reflex-engine.test.ts     # reflex
pnpm pipeline --input pipelines/qm02-trigger-validation.json    # QM-02 検証パイプライン
pnpm pipeline --input pipelines/storage-janitor.json            # EV-06 の uncovered 報告
pnpm daemon:watchdog -- --json                                  # EV-05
```

## 7. 実装状況

### 2026-08-10: EV-01〜10 実装完了（ミッション `MSN-EVENT-UNIFY-20260810`）

着手順は §4 のバッチどおり（EV-10 を赤で立ててから各項目を緑にする）。**checker は着手時 9 件の違反を検出し、完了時 0 件**。

#### 計画時の記述に対する訂正（重要）

- **EV-03 の前提が誤っていた。** 計画本文は「reflex dispatcher はテストでしか bind されておらず反射は 1 件も発火しない」と書いたが、これは調査時の grep 出力が切れて production 配線を見落としたもの。実際は `presence/bridge/nexus-daemon.ts:260` が dispatcher を bind し `:292` で `evaluate()` を呼ぶ、**`enabled: true` の常駐 surface**。したがって EV-03 は「デッドコード撤去」ではなく**稼働経路の安全化**として実施した（方針 A）。なお `knowledge/procedures/reflexes/` は存在しないため、現状の発火件数は 0 件 — 配線の欠落ではなく定義の不在だった。
- **`watch` トリガの配線先は watchdog ではなかった。** `armWatch` は同一プロセス内の managed child を要求するため、detached daemon をハートビートで観測する watchdog からは原理的に使えない。watchdog は `wake` に、`watch` は唯一の正当な対象（in-process・piped・長寿命で quiet 検知が無かった `acp-mediator` の provider セッション）に配線した。

#### 実装内容

- **EV-10: 完了。** `scripts/check_event_wiring.ts` 新設（6 ルール: TriggerSource 全値の production 呼び出し元 / WORKER_EVENT_TYPES の emit 元 / reflex dispatcher bind / heartbeat を出す daemon の watchdog 登録 / イベントストアの retention 宣言 / 実装が消えた機能を説明する文書）。`pnpm check:event-wiring` として `validate` に登録。checker 自身を呼び出し元と誤認しないよう自己除外。テスト 18 件（各ルールが合成ツリーで確実に赤になることを含む）。
- **EV-04 + EV-08: 完了。** `libs/core/jsonl-tail.ts` 新設。ローテーション検知を 3 経路（サイズ後退・inode 変化・**消費済みプレフィクスの**指紋変化）で行い、未完結行は消費しない。**指紋の基準を「ファイル先頭 N バイト」から「既に消費したオフセット」に変えた** — 前者は N 未満のファイルへの追記で毎回指紋が変わり、通常の追記をローテーションと誤検知してカーソルを巻き戻し続ける。`nerve-bridge.listenToNerve` をこれに載せ替え（戻り値が unsubscribe に変更）、TTL 執行を追加。`sensory-memory.getLatestByIntent` は `timeWindowMs` を**必須引数化**（無制限検索は `dynamic-permission-guard` の一時付与が閉じない原因だった）。
- **EV-06: 完了。** `EVENT_STORE_PREFIXES` / `eventStoreRetentionRules` / `coveredEventStoreDirs` を retention catalog モジュールに追加し、`scanEventStores` と `listUncoveredEventStoreDirs` を janitor に新設（report に `expiredEventStores` / `uncoveredEventStoreDirs` を追加）。catalog v1.3.0 に 6 エントリ追加（observability 残余 90d/audit・mission-control 90d/audit・channels 30d・chronos 30d・orchestration/events 14d・presence/bridge/runtime 7d）。`ops-alerts.jsonl` はファイルであり catalog はディレクトリを模すため専用エントリを置かず残余ルールに帰属させた。`scanEventStores` は各ファイルの所有エントリを longest-prefix で解決するため、残余ルールが具体ルールの TTL/audit を上書きしたり二重計上したりしない。`stimuli.jsonl` に 5MB 自己ローテーションを追加。dry-run 実測: 期限切れ 459 件（456 件は 2026-06〜07 の消費済み orchestration queue チケット、正本の journal は残存）、uncovered 0 件。
- **EV-01: 完了。** `hasMissedCronOccurrence` / `sameZonedMinute` を `src/cron-utils.ts` に移して両スケジューラで共有（`maxLookbackMinutes` で長期停止時の走査を有界化）。generation tick を TriggerRunner 経由（冪等キー `gen:{id}:{分}`）+ leader lease + run lock（token 照合解放・期限切れ再取得）化。**`scripts/run_generation_schedule.ts` にあった tick の完全な二重実装を削除して libs/core に単一化** — デーモンが叩くのはスクリプト側だったため、ライブラリだけを直しても本番経路は governed にならなかった。authority role `generation_scheduler` を登録儀式で新設（`chronos_gateway` は media-generation への write scope を持たないため流用不可）。
- **EV-05: 完了。** `run_generation_schedule_daemon.ts` に heartbeat（starting/running/error）と tick 失敗時の ops alert を追加し、**1回の tick 失敗でプロセスを落とすのをやめた**（それ自体が観測されない停止だった）。`DEFAULT_DAEMONS` に `generation-schedule-daemon` を追加・export。
- **EV-02: 完了（方針 A）。** `resolveCurrentTriggerAuthority()` を新設（役割が可変な呼び出し元が registry から真の snapshot を導出できる）。`watch`: `acp-mediator` に `stallWatchMs` / `onStall` を追加し、`armTriggerWatch` で provider セッションの無出力を governed トリガ化（crash は既に `exit` で観測できていたが、生存したまま黙る場合は完全に不可視だった）。`wake`: `daemon_watchdog` に `requestDaemonRecovery` を追加し、不健全 daemon ごとに冪等な wake トリガを立てて `autonomous-ops-gate` の判定を記録。`daemon_restart` アクションを policy に登録（score 7 → **`approve`**: sandbox 外の service-manager コマンドであり、発火中のスケジューラ再起動は重複/欠落を生むため無人実行しない）。authority role `daemon_watchdog` を新設。
- **EV-03: 完了（方針 A）。** reflex engine v2.0: `{{payload}}` の展開を**JSON テキストへの文字列置換 + 再パースから構造的置換へ**（引用符・波括弧・改行を含む payload が params の構造を変えられない）、`REFLEX_ALLOWED_ACTUATORS` によるロード時 + dispatch 時の二段検証、`TriggerRunner` の `wake` トリガによる冪等化（`reflex:{reflex_id}:{stimulus_id}`）と監査。actuator の op-registry 照合は allowlist が厳密に強いため dispatch 経路から外し、**allowlist 自体の妥当性をテストで担保**（実 registry を読む）。`nexus-daemon` の dispatcher は未対応 actuator で throw するようにし（従来は silent no-op）、authority role `nexus_daemon` を canonical 登録（未登録のままでは反射が本番で拒否される）。AUTONOMY_SYSTEM_GUIDE §2 にガバナンス表と「定義が無ければ 1 件も発火しない」旨を追記。
- **EV-07: 完了。** `libs/core/event-vocabulary.ts` 新設。5 つの閉じた語彙（worker / orchestration / task / process watch / operator）を `Record<EnumType, CollaborationKind>` で**型による網羅性強制**にし、`collaborationKindFromEventType` を推測から表引きに置換。自由記述の `decision` 文字列だけは推論に残したが、**結果語を主語より先に評価する順序**に直した（`runtime` を spawn トークンにしていたため `agent_runtime_stopped` 等の終端イベントがすべて spawn に誤分類されていた）。**追加発見**: `phase_begin` / `phase_end` / `gate_evaluated` の 3 型はどこからも emit されていなかったため、遷移を決める唯一の地点 `advanceAiDlcPhase` から emit するよう配線（失敗ゲート時は phase が進まないので `alignment` を begin する）。
- **EV-09: 完了。** `libs/core/trigger-correlation.ts` 新設（AsyncLocalStorage。並行配信が互いの ID を見ない）。TriggerRunner の delivery をこのスコープ内で実行し、`WorkerEventSource` に `trigger_delivery_id` を追加して**明示指定が無い場合のみ**自動付与。`operator-notifications` の correlation と dedupe キーにも伝播（1 発火から出た 2 通は同一イベントとして dedupe される）。

#### 実装中に見つけた別系統の欠陥（本計画で修正）

- **`acquireLock` が非ブロッキング timeout で一度も取得を試さない。** リトライループが `while (elapsed < timeoutMs)` だったため、`withTriggerLeaderLease` が渡す **1ms** の予算を前処理（`safeExistsSync` + `safeMkdir`）で使い切ると、ロックファイルに触れずに `false` を返す。呼び出し側はこれを「他のリーダーが保持中」と読むので、**負荷の高いマシンでは誰も保持していないのにスケジューラの tick が落ちる**。最低 1 回の試行を保証する形に修正（`false` は「本当に保持されている」だけを意味する）。stale purge は 3 回で上限。回帰テスト 2 件追加。QM-02 由来の既存欠陥で、本計画のテストが偶発的に露出させた。

#### 検証

- `pnpm build` 成功 / `npx tsc -p tsconfig.json --noEmit` クリーン
- 新規・改修テスト **123 件**（3 回連続実行で安定）: `jsonl-tail`(13) `event-vocabulary`(8) `event-store-retention`(6) `trigger-correlation`(7) `stimuli-ttl`(5) `generation-scheduler.tick`(14) `cron-utils.catchup`(7) `lock-utils`(4) `reflex-engine`(13) `check_event_wiring`(18) `daemon_watchdog`(4) `run_generation_schedule`(6) + 既存 `trigger-runner` / `pipeline-scheduler`
- `libs/core` 全体 4873 passed / `scripts` 全体 608 passed
- `pnpm check:event-wiring` OK（2465 ファイル走査・6 ルール充足）、`pnpm check:catalogs` OK（authority-role 3 件追加に伴い `pnpm generate:knowledge-index` 実行）
- **未解決の既存失敗（本計画と無関係）**: `libs/core/history-search-index.test.ts` 5 件 — Apple 版 sqlite3 の `trusted_schema=0` による `unsafe use of virtual table` で、当該ファイルに本計画の変更はない（`git diff` 空）。環境依存。

#### 残作業

- `scripts/run_generation_schedule.ts` のテストは委譲の検証に縮小し、tick 本体は `libs/core/generation-scheduler.tick.test.ts` が正本。実運用での初回 janitor 実行で orchestration queue 456 件が削除される点は意図どおりだが、**実環境での初回実行は観測付きで行うこと**。
- EV-02 の `daemon_restart` は `approve` 判定なので、実際の再起動を実行する executor は未実装（意図的）。無人再起動を許すかは運用判断。
