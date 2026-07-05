# E2E-04: オペレータ・インターフェース統合 — 「どこで話しかけ、どこで受け取るか」を1つにする

> 優先度: **P0**(中核ユースケース第4弾 — 人と Kyberion の接面) / 規模: M〜L(タスク分割済み) / 依存: なし(UX-01/IL-01/E2E-01〜03 の成果を利用。SU-01/SU-03 の未了分を本計画が最小形で引き取る)
> 実装担当モデル: 各タスクに明記。**gpt-5.4-mini クラス単独で実装可能な粒度**(README §2.1 の読み替え表)
> 調査日: 2026-07-05(実コード検証済み)
> **実装状況**: 2026-07-05 時点で E2E 側へ編入済み。SU-01 / SU-03 の最小形として扱う。

## 0. 実装エージェントへ(E2E-01〜03 と同じ規約)

- Task 内の手順を上から順に。変更前に対象ファイルを読み、行番号ずれは現状を正とする。
- ファイル I/O は `@agent/core`(secure-io)経由のみ。各 Task の「検証」全通過 + `pnpm lint && pnpm typecheck` で完了。
- **本計画の合言葉は「入口はどこでもいい。ホームと受け取り口は1つ」**: 話しかける場所(Slack/CLI/Web/声)は自由なまま、状態確認・承認・質問回答・成果物受領を単一の導線に集約する。

## 1. 症状と目指す姿

**症状**: 入口が多すぎて(Web 5面・ブリッジ4種・voice・npm scripts 292個)どこで何をすべきか毎回迷う。ミッションの質問・承認・完了は**こちらから見に行かないと気づけない**。成果物は evidence ディレクトリを探しに行く。結果、システムは動いているのに「使っている感」がない。

**目指す姿**:

```
話しかける: どの面からでも(Slack / CLI / Chronos / 声)→ 同じ脳(既に共通化済み)
     ↓
Kyberion からの用事(質問・承認・完了・アラート): 設定した1チャネルへ push される
     ↓
確認する: ホーム1画面(または pnpm kyberion 1コマンド)に全状態と「次の一手」
     ↓
受け取る: 成果物 inbox 1箇所(新着・既読・受領)
```

## 2. 調査結果 — 脳は1つに繋がっている。分裂しているのは「往路の案内」と「復路の配達」

**動く部品(検証済み)**:

| 部品                                                                                                        | 場所                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **意図処理の単一脳**: Slack/Telegram/Discord/iMessage/Chronos は全て `runSurfaceMessageConversation` を通る | 各 bridge `index.ts`、`chronos .../api/agent/route.ts:51,1278`                        |
| goal 解釈と clarification packet(質問生成)                                                                  | `compileUserIntentFlow` + `question-resolver`(IL-01 で goal 貫通済み)                 |
| CLI ダッシュボード(focus 付き)・approval 監査サマリ                                                         | `scripts/sovereign_dashboard.ts:160-220`、`pnpm dashboard:*`                          |
| doctor(健全性+次の一手 `buildNextAction`)・preflight 群                                                     | `scripts/run_doctor.ts`(schedules/maintenance/governance/backup/mesh 表示済み)        |
| Slack 承認ブロック(approve/reject ボタン)・Chronos 危険操作確認モーダル(UX-04)                              | `slack-bridge:398-421`、`MissionIntelligence.tsx`                                     |
| ブリッジ送信部品(封筒・レート制限つき)                                                                      | UX-01 `bridge-error-reply.ts` / slack outbox / `sendTelegramMessage` / `sendIMessage` |
| 成果物の分類語彙(deliverables/artifacts/outputs/evidence)                                                   | `MissionIntelligence.tsx:292`                                                         |
| 運用アラート sink                                                                                           | `ops-alert.ts`(AO-03)                                                                 |

**切れている継ぎ目(ギャップ)**:

- **G1: 「何をどこでやるか」の正本が無い**。Web 5面(chronos / operator-surface / presence-studio / computer-surface / avatar-studio)+ ブリッジ4種 + voice + **npm scripts 292個** + `pnpm cli` / `control` / `dashboard`。役割分担の一覧がどこにもなく、毎回入口探しから始まる。
- **G2: ホームが無い**(SU-01 未実装)。「今 ready か・何件承認待ちか・実行中ミッション・次の一手」を見るのに doctor / dashboard / mission status / approvals を**別々に叩く**必要がある。
- **G3: 復路(Kyberion→人)が push されない**。ミッションからの質問(clarification)・承認要求・完了・失敗は各面に**置かれるだけ**で、operator の常用チャネルに届かない。通知先設定(notification preferences)という概念自体が無い。ops-alert(AO-03)は運用障害専用で、ワークフロー通知には未使用。
- **G4: 成果物の受け取り口が無い**(SU-03 未実装)。完了成果物は `active/missions/<id>/evidence/` を自分で探す。新着・既読・受領の概念が無い。
- **G5: CLI だけ脳が別**。`scripts/cli.ts` は独自の intent 解決+clarification(`cli.ts:1654-1713`)を持ち、surface 経路(`runSurfaceMessageConversation`)と挙動が食い違う(学習ループ・goal 貫通・封筒の恩恵を受けない)。
- **G6: 設定の入口が不明**(OP-05 未実装、181 env)。「通知先を変えたい」「テナントを切り替えたい」がどのファイル/コマンドか分からない。

## 3. ゴール(受入条件)

1. `pnpm kyberion` 1コマンドで、状態ダイジェスト(ready/blocked・承認待ちN件・質問待ちN件・実行中ミッション・inbox 新着N件)+「次の一手」+ 主要コマンド10個の案内が出る。
2. `knowledge/personal/notification-preferences.json` で通知先(slack/imessage/telegram/discord のチャネル)とイベント種別を設定でき、**質問・承認要求・ミッション完了/失敗・成果物到着が設定チャネルへ push される**。
3. 成果物 inbox が1箇所(`active/shared/inbox/` + operator-surface の Inbox ページ)に集まり、新着/既読/受領(accept)が管理できる。
4. Chronos に**オペレータホーム**(1画面: 状態・実行中・承認/質問キュー・inbox 新着・次の一手)ができる(SU-01 の最小形)。
5. 自由文の依頼に対し「解釈された goal + 実行計画プレビュー(shape/チーム/フェーズ/期待成果物)」が**着手前に**表示され、編集して承認できる(SU-01 の核。承認後は IL-01 経路でミッションへ)。
6. `pnpm cli` の意図処理が surface 経路に統一される(挙動差の解消)。
7. `docs/SURFACES.md` が「入口×できること」の正本になり、全 surface から参照される。
8. 2〜5 が stub backend の E2E テストで検証される。

## 4. 実装タスク

### Task 1: 単一入口コマンド `pnpm kyberion` — `gpt-5.4-mini`

1. `scripts/kyberion_home.ts` を新設、`package.json` に `"kyberion": "node dist/scripts/kyberion_home.js"` を追加。
2. 表示内容(**すべて既存 API の再利用。新ロジック禁止**):
   - 状態: `collectDoctorReport({})` の totalMissing と must/should 概要(1行)
   - 承認待ち: `getGovernanceControlSummary().pending_approvals`
   - 質問待ち: pending clarification の格納場所を `question-resolver` から特定して件数(無ければ「質問キューは Task 2 で新設」とし 0 固定で先に進む)
   - 実行中ミッション: `loadState` 系で status=active のミッション一覧(`mission_controller list` の内部関数を再利用)
   - inbox 新着: Task 3 の `listInboxEntries({ unread: true }).length`
   - 次の一手: 既存 `buildNextAction` / `formatNextAction`
   - 最後に「主要コマンド」10行(mission create / meeting:preflight / pipeline campaign-suite / dashboard / doctor / backup / inbox open / notification set / cli / help)を固定表示
3. `--json` オプションで機械可読出力(Chronos ホーム(Task 4)が同じ集計を使うため、**集計部は `libs/core/operator-home-summary.ts` に置き core から export**。CLI はその薄い表示層)。
4. **検証**: `pnpm kyberion` 実行で全セクション表示 / `libs/core/operator-home-summary.test.ts`(各ソースをモックして件数集計を固定)。

### Task 2: 通知ルーティング(復路の配達)— `gpt-5.4-mini`

1. `libs/core/operator-notifications.ts` を新設:
   ```ts
   type OperatorEvent =
     | 'question'
     | 'approval_required'
     | 'mission_completed'
     | 'mission_failed'
     | 'deliverable_ready'
     | 'ops_alert';
   interface NotificationPreferences {
     default_channel?: { surface: 'slack' | 'imessage' | 'telegram' | 'discord'; target: string }; // 例 slack channel ID
     per_event?: Partial<Record<OperatorEvent, { surface; target } | 'mute'>>;
   }
   function notifyOperator(
     event: OperatorEvent,
     payload: { title: string; body: string; link_hint?: string; correlation_id?: string }
   ): Promise<boolean>;
   ```

   - 設定は `knowledge/personal/notification-preferences.json`(スキーマ `schemas/notification-preferences.schema.json` 新設、`check:contract-schemas` 対象に)。未設定イベントは default_channel、default も無ければ **ops-alert JSONL に記録して false**(無言で捨てない)。
   - 送信実装は既存部品へ委譲: slack= slack outbox 書込(`listSlackOutboxMessages` の書込側 API を grep)、imessage= `sendIMessage`、telegram= `sendTelegramMessage`、discord= bridge が poll する outbox JSONL(無ければ slack と同型で新設 ±30行)。UX-01 の**会話単位レート制限**(`shouldPostBridgeError` と同型・イベント種別単位)を内蔵。
2. 発火点の配線(各1〜3行の挿入。失敗許容 warn):
   - 承認要求作成時(`approval-gate.ts` の「New approval request created」経路)→ `approval_required`
   - clarification packet 生成時(`question-resolver` の packet 生成箇所)→ `question`
   - mission finish / failed(`mission-lifecycle.ts` の KM-01 フックと同じ場所)→ `mission_completed` / `mission_failed`
   - Task 3 の inbox 追加時 → `deliverable_ready`
3. 設定用コマンド: `pnpm kyberion notify --set slack:#general` 相当を Task 1 の CLI にサブコマンド追加(preferences JSON を書くだけ)。
4. **検証**: unit test — per_event 優先/デフォルト/mute/未設定フォールバック/レート制限。発火点は mission-lifecycle テストに1ケース追加(notifyOperator がモックで呼ばれる)。

### Task 3: 成果物 inbox(SU-03 の最小形)— `gpt-5.4-mini`

1. `libs/core/deliverable-inbox.ts` を新設:
   - 実体: `active/shared/inbox/entries.jsonl`(`{ entry_id, mission_id, title, artifact_paths[], summary, created_at, status: 'unread'|'read'|'accepted', tenant_slug? }`)
   - API: `addInboxEntry` / `listInboxEntries(filter)` / `markInboxEntry(entry_id, status)`
2. 配線: mission finish フック(E2E-01 Task 5 と同じ場所。既に delivery pack を作る分岐がある場合はその直後)で、outcome_contract の expected/実成果物パスから `addInboxEntry` → `notifyOperator('deliverable_ready', …)`。
3. 表示: (a) `pnpm kyberion inbox`(一覧+ `--read <id>` / `--accept <id>`)、(b) operator-surface に `/inbox` ページ(既存の read-only ページ群と同じ作りで entries.jsonl を表示。accept ボタンは POST 1本)。
4. **検証**: unit test(add/list/mark 往復、tenant フィルタ)/ fixture ミッション finish で entry が増え notify が呼ばれる test。

### Task 4: Chronos オペレータホーム(SU-01 最小形)— `gpt-5.4-mini`

1. chronos に `/api/operator-home` route を新設し、Task 1 の `operator-home-summary`(core export)をそのまま返す。
2. `FocusedOperatorView`(または新コンポーネント `OperatorHome.tsx`)で1画面表示: 状態バッジ / 実行中ミッション(クリックで既存 MissionIntelligence へ)/ 承認・質問キュー(既存 UX-04 モーダル・承認 API に接続)/ inbox 新着(Task 3)/ 次の一手。デザインは DS-01 のトークン(`--kb-*`)のみ使用、ハードコード色禁止(E2E-02 G3 と同じ規約)。
3. design-system ショーケースが初期表示なら `/design-system` へ退避し、ホームを既定に(SU-01 受入1)。
4. **検証**: `pnpm build:ui` 成功 / route の unit test(summary モック)/ 既存 chronos 契約テスト(`mission-orchestration-dashboard-contract` 等)緑。

### Task 5: goal→計画プレビュー承認(SU-01 の核)— `claude-sonnet-4` 相当(UI/UX 判断が要る)

1. chronos ホームに「依頼を伝える」入力を置き、送信で **実行はせず** `/api/plan-preview` へ:
   - `compileUserIntentFlow(text)` を呼び、`{ goal, execution_shape, mission_class(分類), workflow(フェーズ列 = MO-01 の resolveMissionWorkflowDesign), team_template, expected_artifacts(outcome contract preview) }` を返す(**全部既存関数。組むだけ**)。
2. プレビューパネルで編集可: goal.summary / success_condition(テキスト)、mission_type(select)、tier(select)。「承認して開始」で `/api/agent` の既存ミッション作成経路に **IL-01 の intent-handoff**(`writeIntentGoalHandoff`)を通して渡す(E2E-01/IL-01 と同一経路 — UI とバックエンドの goal が一致、SU-01 受入4)。
3. 「二値 yes/no の廃止」(SU-01 受入3)はこの画面が担う。既存チャット経路は現状維持(後方互換)。
4. **検証**: plan-preview route の unit test(stub compile 結果 → preview 構造)/ 承認 POST で intent-handoff ファイルが作られ create 引数に `--intent-goal` が付くこと。

### Task 6: CLI 経路の統一 — `claude-sonnet-4` 相当(削除を伴うため判断が要る)

1. `scripts/cli.ts` の独自 intent 解決(`:1654-1713` の clarification 含む)を `runSurfaceMessageConversation({ surface: 'cli', text, … })` 呼び出しに置換。clarification packet が返ったら CLI では readline で質問→回答を再送(対話ループ。非 TTY では質問を表示して exit 2)。
2. 削除ではなく**委譲**: 既存関数は deprecated コメント付きで残し、呼び出しだけ差し替え(IP-04 の死参照掃除は別途)。
3. **検証**: `pnpm cli -- "ミッション一覧見せて"` 相当の代表3発話が surface 経路で処理される(stub)/ 既存 cli テスト緑。

### Task 7: 入口の正本 `docs/SURFACES.md` — `gpt-5.4-mini`

1. 1表で「入口 × 主用途 × 起動コマンド × 向いていない用途」: Chronos(ホーム/計画承認/介入)、operator-surface(閲覧: 監査/健全性/inbox)、Slack 等ブリッジ(会話・承認・通知受信)、voice(会話)、`pnpm kyberion`(CLI ホーム)、`pnpm cli`(スクリプト実行)、presence-studio / computer-surface / avatar-studio(それぞれ1行)。
2. `README.md` / `docs/OPERATOR_UX_GUIDE.md` / `pnpm kyberion` の出力末尾からリンク。**手順の実体は書かない**(ONB-02 の単一正本規約: INITIALIZATION が正本、本書は「地図」)。
3. **検証**: `pnpm run check:reference-drift` / `check:doc-examples` 緑。

### Task 8: インターフェース E2E テスト — `gpt-5.4-mini`

1. `tests/operator-interface-e2e.test.ts`(stub、通知送信はモック):
   - preferences fixture(slack 既定・mission_failed は mute)→ `notifyOperator` のルーティング/ミュート/フォールバックを検証
   - fixture ミッション finish → inbox entry + `deliverable_ready` 通知 → `markInboxEntry('accepted')`
   - `operator-home-summary` が承認1件・inbox 新着1件を正しく集計
   - plan-preview(stub compile)→ 承認 → intent-handoff 生成
2. **検証**: 本テスト + 既存 chronos/cli/bridge 系テスト全緑。

## 5. リスクと注意

- **通知の騒音**: レート制限(イベント種別×correlation 単位)と mute を最初から入れる。既定は「質問・承認・完了のみ」— 進捗の逐次 push はしない(UX-02 の領分。欲しくなったら per_event で opt-in)。
- **通知チャネルは confidential になり得る**: preferences は `knowledge/personal/`(tier 保護下)。通知本文に成果物の中身や confidential パスを書かない(タイトル+リンクヒントのみ。AO-03 の ops-alert と同じ規約)。
- **SU-01/SU-03 本計画との関係**: 本計画は両者の「最小形」。完了時に SU-01/SU-03 文書へ「最小形は E2E-04 で実装済み、残余(プラン編集の高度化・成果物の版管理/差戻し)は原計画で」とステータス追記すること。
- **Task 6 の後方互換**: cli.ts は多数のサブコマンドを持つ。置換対象は**自由文 intent 経路のみ**で、明示サブコマンド(mission list 等)は触らない。
- Chronos の追加 API は既存の `api-guard`(認証ガード)を必ず通す(`route.ts` 冒頭の `guardRequest` 流儀)。

## 6. 実施順序

Task 1(CLI ホーム)→ Task 2(通知)→ Task 3(inbox)→ Task 4(Chronos ホーム)→ Task 8(E2E)→ Task 5(計画承認)→ Task 7(地図)→ Task 6(CLI 統一)。
**Task 1〜3 で「見に行かなくても届く・1コマンドで全部見える」が成立**し、体感が最も変わる。Task 4〜5 が Web ホーム、6〜7 は仕上げ。
