# E2E-01: 会議→価値提供の縦一気通貫 — 「部品は全部あるのに流れない」の解消

> 優先度: **P0**(プロダクトの中核ユースケース) / 規模: M(タスク分割済み) / 依存: なし(AC-01/UX-01/OP-02 の成果を利用)
> 実装担当モデル: 各タスクに明記。**すべて gpt-5.4-mini クラス単独で実装可能な粒度**に分割してある。README §2.1 のモデル読み替え表に従うこと。
> 調査日: 2026-07-05(実コード検証済み。行番号は当日時点)

## 0. このドキュメントの読み方(実装エージェントへ)

- 各 Task は独立に着手でき、**Task 内の手順を上から順に**実行する。判断に迷う選択肢は本文に明記した既定を採る。
- 変更前に対象ファイルを読み、行番号がずれていたら現状を正とする。
- 各 Task の最後の「検証」コマンドが全部通ったらそのタスクは完了。`pnpm lint && pnpm typecheck` は全タスク共通の完了条件。
- ファイル I/O は必ず `@agent/core`(secure-io)経由。`node:fs` 直 import 禁止(AGENTS.md §1)。

## 1. 目指すフロー(オーナーの想い)

```
① 自分の声を学習 → ② その声で会議に参加しファシリテーション → ③ 議事録
→ ④ アクションアイテム化 → ⑤ タスク/ミッション化しエージェント協調で高品質成果物
→ ⑥ 顧客への価値として提供・記録
```

## 2. 調査結果 — 部品は存在する。切れているのは「継ぎ目」

**実装済みで動く部品(検証済み)**:

| 段階 | 部品 | 場所 |
|---|---|---|
| ① | `collect_voice_samples` / `register_voice_profile` / `collect_and_register_voice_profile` | `libs/actuators/voice-actuator/manifest.json:23-26` |
| ② | 本人ボイス TTS + BlackHole 経由の会議音声注入 | `libs/actuators/meeting-actuator/meeting-bridge.py:25,45-46`(voice_learning_bridge + blackhole_audio_router) |
| ② | 発話同意ゲート(テナント/期限検査)・`pnpm meeting:consent` | `meeting-actuator-helpers.ts:309-321`、`package.json:97` |
| ② | Playwright 会議参加ドライバ | `libs/actuators/meeting-browser-driver/` |
| ② | ファシリテーションスクリプト生成 / 発話公平性監査 | `wisdom:generate_facilitation_script` / `audit_speaker_fairness`(`decision-ops.ts:2387,2480`) |
| ④ | 議事録→アクションアイテム抽出・保存・話者確認 | `wisdom:extract_action_items`(`decision-ops.ts:2320`)+ `action-item-store.ts`(schema 付き JSONL) |
| ⑤ | 自分担当アイテムの自動実行ディスパッチ / 他者担当の督促追跡 | `wisdom:execute_self_action_items` / `track_pending_action_items`(`decision-ops.ts:2421,2450`) |
| ⑤ | フェーズ定義(会議代理・ファシリ後続・アイテム督促の3ワークフロー) | `mission-workflow-catalog.json`(`meeting-proxy-live-participation` / `ai-meeting-facilitator-followup` / `action-item-tracking-followup`) |
| ⑥ | 成果物 delivery pack / テナント export / バックアップ | `artifact-actuator`、`scripts/backup.ts --scope tenant`(OP-02) |

**切れている継ぎ目(ギャップ)**:

- **G1: 前提条件が実行時に初めて落ちる**。Playwright ブラウザ・BlackHole 仮想デバイス・mlx-audio tool runtime・Python ブリッジ依存・voice profile 登録済みか・consent が有効期限内か — これらを**会議前に一括検査する入口が無い**。`pnpm doctor --runtime meeting` は manifest probe のみで consent/profile を見ない。未分類エラーレジストリに playwright/prerequisite 系の実失敗が記録されている。
- **G2: 声のオンボードが多段手動**。①は `voice-actuator` への JSON 入力ファイル手作りで、collect→register→consent 登録の順序・形式がどこにも一本化されていない。
- **G3: ミッションテンプレートが `development` 1種のみ**(`knowledge/product/governance/mission-templates.json` — `templates[].name` は `['development']` だけ)。会議ミッションを作っても TASK_BOARD/PLAN が開発用の雛形になり、catalog の `ai-meeting-facilitator-followup` フェーズ列(intake→agenda_and_role_boundary→live_facilitation→postprocess→self_execution→team_tracking→delivery)は**ラベルとして表示されるだけで誰も駆動しない**。
- **G4: 会議後の連結パイプラインが無い**。`pipelines/meeting-proxy-workflow.json` は log+shell+extract_requirements のみ。transcript→議事録文書(media-actuator)→`extract_action_items`→話者確認→`execute_self_action_items`→`track_pending_action_items` を**1本で流すパイプラインが存在しない**(毎回手で個別 op を叩くことになり「いちいちうまくいかない」の主因)。
- **G5: 督促が届かない**。`track_pending_action_items` はレポートを作るが、**リマインダーを Slack 等のブリッジへ送る配線と cron 登録が無い**(`action-item-tracking-followup` は catalog にあるが `pipelines/` に実体なし)。
- **G6: 成果物→顧客提供の一本道が無い**。delivery pack 化・顧客 overlay への配置・提供記録(いつ何を誰に)を繋ぐステップが未定義(SU-03 は未実装)。

## 3. ゴール(受入条件)

1. `pnpm meeting:preflight` 1コマンドで、①〜②の全前提(下記 Task 1 の表)が PASS/FAIL + 直し方つきで出る。FAIL があるまま会議参加を始めない。
2. `pnpm pipeline --input pipelines/voice-onboarding.json` 1本で、サンプル収集→profile 登録→試聴確認→consent 登録まで完了する。
3. `mission_controller create <ID> --mission-type meeting_facilitation` で、会議フロー専用の TASK_BOARD/PLAN(フェーズ列 = ai-meeting-facilitator-followup)を持つミッションが生成される。
4. 会議終了後 `pnpm pipeline --input pipelines/meeting-followup.json --context '{"mission_id":"..."}'` 1本で、議事録 md/docx・action-items.jsonl・自分担当の実行ディスパッチ・督促キュー登録まで自動で終わる。
5. 督促 cron が日次で回り、期限超過アイテムのリマインダーが Slack ブリッジ経由で届く(UX-01 のエラー封筒/レート制限を再利用)。
6. ミッション finish 時に議事録+アイテム消化レポートが delivery pack になり、`customer/<slug>/deliverables/` に置かれ提供記録(JSONL)が残る。
7. fixture transcript を使った E2E リハーサルテスト(stub backend・実会議なし)が CI で緑。

## 4. 実装タスク

### Task 1: 会議前 preflight の一本化 — `gpt-5.4-mini`

1. `scripts/meeting_preflight.ts` を新設し、`package.json` に `"meeting:preflight": "node --import ./scripts/ts-loader.mjs scripts/meeting_preflight.ts"` を追加。
2. 検査項目(各項目 `{ id, status: pass|fail|warn, detail, fix }` で出力。1つでも fail なら exit 1):
   - `doctor.meeting`: 既存 `collectDoctorReport({ runtime: 'meeting' })`(`scripts/run_doctor.ts`)を呼び must 欠落を fail に。
   - `playwright.browser`: 既存 probe(`libs/core/environment-capability-probes.ts` の `playwright.chromium-browser`)を流用。fix=`pnpm exec playwright install chromium`。
   - `blackhole.device`: `safeExecResult('system_profiler', ['SPAudioDataType'])` の出力に `BlackHole` が含まれるか。fix=`brew install blackhole-2ch`。darwin 以外は warn(スキップ)。
   - `mlx.audio.runtime`: `active/shared/runtime/tool-runtimes/mlx-audio/bin/python` の存在(`meeting-bridge.py:63-64` と同じパス)。fix は tool-runtime セットアップコマンドを `listToolRuntimeInventory()` から引く。
   - `voice.profile`: voice profile ストア(`voice_learning_bridge.py` が書く profiles ディレクトリ。実パスは `libs/actuators/voice-actuator/scripts/voice_learning_bridge.py` を読んで確認)に 1 件以上あるか。fix=`Task 2 の voice-onboarding を実行`。
   - `voice.consent`: `checkSpeakConsent()`(`meeting-actuator-helpers.ts` から export されていなければ export を追加)で allowed か。fix=`pnpm meeting:consent`。
   - `reasoning.backend`: `reasoning-backend.any-real` probe(ONB-01)を流用。
3. unit test: 各項目を モックで pass/fail にして exit code と fix 文言を固定(`scripts/meeting_preflight.test.ts`)。
4. **検証**: `pnpm meeting:preflight`(現環境で実行し、FAIL項目に fix が表示されること)/ `pnpm exec vitest run scripts/meeting_preflight.test.ts`。

### Task 2: 声オンボードの一本化 — `gpt-5.4-mini`

1. `pipelines/voice-onboarding.json` を新設。steps:
   1. `system:log`(開始案内: 所要・マイク準備)
   2. voice-actuator `collect_and_register_voice_profile`(既存 op。params は `libs/actuators/voice-actuator/src/index.ts:81-140` の型に従う。`name` はcontext `{{profile_name}}` 既定 `owner-voice`)
   3. voice-actuator `generate_voice`(登録した profile で短文を合成し `active/shared/tmp/voice-onboarding-check.wav` に出力)
   4. `system:log`(試聴パスの案内: `afplay <path>` で確認せよ)
   5. `system:exec` → `node dist/scripts/voice_consent.js`(consent 登録。引数は `scripts/voice_consent.ts` を読んで非対話で渡せる形にし、無ければ `--grant --tenant default` 相当のフラグを voice_consent.ts に追加)
2. `docs/OPERATOR_UX_GUIDE.md` に「声のオンボード(1コマンド)」節を追記。
3. **検証**: `pnpm pipeline --input pipelines/voice-onboarding.json --context '{"dry_run":true}'` が dry-run で全ステップ green(collect はサンプル数0でも dry-run 成功にする。既存 op に dry_run が無ければ context の `dry_run` を見て skip する分岐を voice-actuator 側に足す。±20行)。`check:pipeline-shell-independence` 通過。

### Task 3: meeting_facilitation ミッションテンプレート — `gpt-5.4-mini`

1. `knowledge/product/governance/mission-templates.json` の `templates[]` に `name: "meeting_facilitation"` を追加。既存 `development` エントリを複製し、`files[]` の `TASK_BOARD.md` / `PLAN.md` の content_template を会議フローに差し替える:
   - TASK_BOARD の Execution Phase を catalog の `ai-meeting-facilitator-followup` フェーズ列(agenda_and_role_boundary → live_facilitation → postprocess → self_execution → team_tracking → delivery)のチェックリストにする。
   - PLAN に「入力: 会議URL/参加者/アジェンダ」「成果物: minutes.md, action-items.jsonl, delivery pack」を明記。
2. `mission-team-plan-composer.ts` のチームテンプレートキー解決(`:148-159`)が `meeting_facilitation` を未定義キーとして fallback しないか確認し、必要なら `mission-team-templates.json` に同名エントリ(planner+operator の最小編成)を追加。
3. test: `mission-workflow-catalog.test.ts` の流儀で「`missionTypeHint: 'meeting_facilitation'` の分類が `operations_and_release` 系に落ち、workflow が `ai-meeting-facilitator-followup` になる」ことを固定(分類ルールが無ければ `mission-task-classification-scenarios.json` 側にルール追加)。
4. **検証**: `node dist/scripts/mission_controller.js create MSN-MEETING-TEST --mission-type meeting_facilitation --ephemeral` で TASK_BOARD に会議フェーズが並ぶこと。`pnpm exec vitest run libs/core/mission-workflow-catalog.test.ts`。

### Task 4: 会議後フォローアップの連結パイプライン — `gpt-5.4-mini`(op は全て既存。新規ロジック無し)

1. `pipelines/meeting-followup.json` を新設。context 必須: `mission_id`, `transcript_path`(会議ドライバが書く transcript の実パスは `meeting-browser-driver` の AudioBus/transcript 出力を読んで確認)。steps:
   1. `wisdom:distill` または media-actuator `document_digest` で transcript → 議事録 markdown(`active/missions/.../evidence/minutes.md`)
   2. media-actuator `document_report_design_from_brief` 系で minutes.docx を生成(任意。失敗しても継続= `continue_on_error: true` 相当が無ければ省略可)
   3. `wisdom:extract_action_items`(mission_id を渡す。結果は action-item-store に入る)
   4. `wisdom:execute_self_action_items`(mission_id)
   5. `wisdom:track_pending_action_items`(mission_id, output_path=evidence 配下)
   6. `system:log` でサマリ(抽出N件 / 自動実行M件 / 督促待ちK件)
2. `pipelines/action-item-reminders.json` を新設: `schedule.cron: "0 9 * * *"`(JST 朝9時)で全 active mission の `track_pending_action_items` を回し、`generate_reminder_message`(`decision-ops.ts:2405`)の出力を **slack-bridge outbox**(`listSlackOutboxMessages` の書込み側 API。`libs/core` の slack outbox 書込関数を grep して使う)へ積む。宛先チャネルは context `reminder_channel`(既定は operator DM 相当の設定値)。
3. **検証**: fixture transcript(Task 7 で作る `tests/fixtures/meeting-transcript-sample.md`)で `pnpm pipeline --input pipelines/meeting-followup.json --context '{"mission_id":"MSN-MEETING-TEST","transcript_path":"tests/fixtures/meeting-transcript-sample.md"}'` が全ステップ成功し、`action-items.jsonl` が生成されること(KYBERION_REASONING_BACKEND=stub で決定論的に)。

### Task 5: 成果物→顧客提供の一本道 — `claude-sonnet-4` 相当(判断が少し要る)

1. `scripts/refactor/mission-lifecycle.ts` の finish 経路(KM-01 の volatile-gc 起動と同じ場所)に、mission_type が `meeting_facilitation` かつ `customer/<tenant_slug>/` が存在する場合のフックを追加:
   - `minutes.md` + `action-items.jsonl` + 消化サマリを artifact-actuator の delivery pack にまとめる(既存 op を `CAPABILITIES_GUIDE.md` の artifact-actuator 節で確認)。
   - `customer/<slug>/deliverables/<mission_id>/` にコピーし、`customer/<slug>/deliverables/delivery-log.jsonl` に `{ mission_id, delivered_at, artifacts[], summary }` を追記。
   - 失敗してもミッション完了を妨げない(warn + trace。KM-01 フックと同パターン)。
2. tenant_slug が無いミッションは何もしない(後方互換)。
3. **検証**: fixture ミッション(tenant_slug=demo、customer/demo を一時作成)で finish → delivery-log に1行増えること。unit test を `mission-lifecycle.test.ts` に追加。

### Task 6: E2E リハーサルテスト — `gpt-5.4-mini`

1. `tests/fixtures/meeting-transcript-sample.md` を新設(日本語の模擬会議 transcript。発言者3名、決定2件、アクションアイテム3件 — うち1件は自分担当、2件は他者担当・期限付き)。
2. `tests/meeting-to-value-e2e.test.ts` を新設(`KYBERION_REASONING_BACKEND=stub`):
   1. ephemeral mission を `meeting_facilitation` で作成 → TASK_BOARD に会議フェーズがある
   2. meeting-followup パイプラインを runSteps 直呼びで実行 → minutes.md と action-items.jsonl が生成される
   3. `listActionItems(missionId)` で3件、`listOthersPending` で2件
   4. `track_pending_action_items` のレポートに期限付き2件が載る
   5. 後片付け(ephemeral mission 削除、`KYBERION_KNOWLEDGE_ROOT` は tests/a2a-lifecycle.test.ts と同じ隔離パターン)
3. **検証**: `pnpm exec vitest run tests/meeting-to-value-e2e.test.ts` 緑。`tests/` スイート全体も緑のまま。

### Task 7: ドキュメント正本 — `gpt-5.4-mini`

- `docs/OPERATOR_UX_GUIDE.md` に「会議→価値提供 実行手順」節を新設: `meeting:preflight` → (初回のみ voice-onboarding)→ mission create → `meeting:participate` → 会議 → meeting-followup → finish、の順で**コマンドをコピペ可能な形で**列挙。各コマンドの失敗時の一次対応(preflight 再実行 / doctor)も1行ずつ。

## 5. リスクと注意

- **実会議での検証は本計画のスコープ外**(Task 6 は fixture リハーサル)。実会議の初回は必ず operator 同席で行い、`audit_speaker_fairness` の結果を確認してから無人化を検討する。
- 声・会議音声・議事録は confidential。生成物は必ずミッション tier 配下(`active/missions/.../evidence/`)か `customer/<slug>/` に置き、`active/shared/tmp/` に残さない(voice-onboarding の試聴 wav のみ tmp 可 — janitor が24hで回収)。
- 発話 consent(`checkSpeakConsent`)のゲートは**絶対に緩めない**。preflight で「無効」を検出したら consent 再登録を案内するのみ。
- Task 4 の reminder 送信は UX-01 の `postBridgeError` と同様に**会話単位レート制限**の考え方を踏襲し、同一アイテムの督促は1日1回まで。
- MO-02(フェーズゲート、Codex 実装中)が完成したら、Task 3 のフェーズ列は自動ゲート駆動に置き換わる。本計画はそれまでの「チェックリスト + 連結パイプライン」による現実解であり、衝突しない。

## 6. 実施順序

Task 1(preflight)→ Task 2(voice)→ Task 3(テンプレート)→ Task 4(連結)→ Task 6(E2E テスト)→ Task 5(顧客提供)→ Task 7(手順書)。Task 1〜3 は並行可。
