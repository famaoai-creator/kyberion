# Concierge 秘書室 全面改善計画(CS-00〜CS-05)

> **作成日**: 2026-08-02
> **対象**: `presence/displays/concierge`(秘書室サーフェス)とその周辺(voice-hub、surface orchestrator、config-mission)
> **関連ミッション**: `MSN-CONCIERGE-SECRETARY-20260802`(本計画が requirements の blocking 質問「Concierge Secretary の具体的な製品機能・利用者・成功条件」への回答となる)
> **ステータス表記**: 各フェーズ末尾の「実装状況」節に記録(07 月次規約と同一)

---

## 0. プロダクト定義(blocking 質問への回答)

**Concierge(秘書室)= Kyberion 利用者(CEO/オペレータ)の専属秘書。**
利用者が Kyberion に対して行う必要のある業務・設定を**一箇所で・会話(テキスト/音声)で・網羅的に**行えるサーフェス。

- **利用者**: Kyberion のオーナー人間(ソロ創業者/CEO ペルソナ)。開発者ではない前提。
- **提供価値**: 「コマンドをコピペする場所」から「秘書に頼む/秘書が伺いを立てる場所」への転換。
- **成功条件**:
  1. 利用者が日常的に必要とする操作(§2 の秘書業務カタログ)がすべて Concierge から完結する(CLI を開かない)。
  2. テキストと音声のどちらでも同じ依頼ができる。
  3. 実行機構(actuator 名・パイプライン ID 等)は露出しない([ceo-ux.md](../../../knowledge/product/architecture/ceo-ux.md) の契約を維持)。
  4. すべての書き込みは既存のガバナンス(authority role `sovereign_concierge`、承認フロー、effect level)を通る。GUI だからといって統制が緩まない。
- **スコープ外**: 実行機構の可視化(→ chronos-mirror-v2)、監査(→ operator-surface)、ライブ作業(→ presence-studio)。役割分担は [SURFACES.md](../../SURFACES.md) を維持。

**設計原則**(既存契約に準拠):

- 外部概念は [USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md) の 4 つだけ — **依頼 / 実行単位 / 成果物 / 次の一手**。会話形も同契約の 4 形(Clarification / Execution Preview / Status Summary / Delivery Summary)。
- Concierge はインテントループ([INTENT_LOOP_CONCEPT](../../INTENT_LOOP_CONCEPT.md))の **①受信・②明確化の顔**。ルーティング判断は自前で持たず `runSurfaceMessageConversation` / `resolveSurfaceIntent` に委譲([CONCIERGE_AND_DASHBOARD_DESIGN.ja.md](../CONCIERGE_AND_DASHBOARD_DESIGN.ja.md) §direct_reply 判定)。
- **人間判断ゲートは自動化しない**: mission hygiene の start/cancel 判断、`circuit_broken: true` 時の復旧停止は「秘書が伺いを立てる」UI として表出する(勝手に進めない)。

---

## 1. 現状の問題(調査結果 2026-08-02)

| #   | 問題                                                                                                                                                                                                                                                                              | 根拠                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P1  | **二重実装**: Next.js 版(port 3050、登録済み、承認/受領ダッシュボードのみ)と旧 Express 版(port 3033、未登録、アバター+音声チャット)が同居し、**会話・音声機能が登録サーフェスから到達不能**                                                                                       | `presence/displays/concierge/src/app/**` vs `server.ts` + `static/index.html`    |
| P2  | **crash-loop**: manifest が `next start` のみ実行し `next build` が走らないため、2026-07-26 以降起動失敗を繰り返している                                                                                                                                                          | `active/shared/logs/surfaces/concierge.log`(`Could not find a production build`) |
| P3  | **/setup が読み取り専用**: 「変更は各コマンドで」とシェルコマンドを印字するだけ。秘書ではなく掲示板                                                                                                                                                                               | `src/app/setup/page.tsx:65`、`api/setup/route.ts`(GET のみ)                      |
| P4  | **業務網羅性の欠如**: セットアップ・プロバイダ設定・通知設定・ナレッジ取込・プラグイン承認等、ユーザ業務のほぼ全てが CLI か JSON 手編集。GUI 書き込み経路は承認・成果物受領のみ                                                                                                   | ユーザ業務インベントリ(§2)                                                       |
| P5  | **UI 品質**: 30 秒 `setInterval` ポーリング、修正依頼が `window.prompt`、素の CSS、状態管理なし、ストリーミングなし                                                                                                                                                               | `src/app/page.tsx:93-97,139`                                                     |
| P6  | **i18n ゼロ + 方式乖離**: main は日本語ハードコード。pr653 worktree にパッケージローカル `messages.json` 方式の未コミット実装があるが、全体計画([INTERNATIONALIZATION_PLAN](../improvement-plans-2026-07/INTERNATIONALIZATION_PLAN_2026-07-26.ja.md))の共通語彙カタログ方式と乖離 | `.worktrees/pr653` 差分(+941/−147、未コミット)                                   |
| P7  | **未コミット資産の消失リスク**: pr653 worktree に /setup 書き込み化(テナント CRUD・アバター/音声サンプル登録・サービス接続カタログ)+応答状況パネルの実装が working-tree のみで存在                                                                                                | 同上                                                                             |
| P8  | **設計文書の陳腐化**: CONCIERGE_AND_DASHBOARD_DESIGN.ja.md が port 3033 / `/health` 前提のまま                                                                                                                                                                                    | 同文書 :49,:110,:128-129                                                         |

---

## 2. 秘書業務カタログ(網羅性の定義)

「網羅的」を CLI 全コマンドの GUI 化と解釈しない。**利用者ペルソナが行う業務**を以下のカタログとして定義し、これを Concierge の到達目標とする(開発者業務は対象外)。各項目に現行手段と提供方式を明記する。

凡例 — 提供方式: **A**=会話+専用 UI 両方 / **B**=専用 UI(フォーム/一覧) / **C**=会話のみ(裏で既存 core API)/ **状況**=読み取り表示のみ

| 業務                                     | 現行手段(CLI/手編集)                             | 方式   | 裏で使う既存資産                                                                                                        |
| ---------------------------------------- | ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **初期セットアップ**                     |                                                  |        |                                                                                                                         |
| 環境・前提チェック                       | `pnpm doctor` / `setup:report`                   | 状況+B | `scripts/setup_report.ts` の集約結果を API 化                                                                           |
| アイデンティティ設定(自分・エージェント) | `pnpm onboard`(TTY 必須)/ `onboard:apply`        | **B**  | `onboard:apply` 相当の非対話パス+`writeTenantProfile`(pr653 実装を回収)                                                 |
| アバター登録・音声プロファイル登録       | `onboard:avatar` / `onboard:voice`               | **B**  | pr653 の `getUserMedia`/`MediaRecorder` 実装、`saveBrowserOnboardingVoiceSample`                                        |
| 顧客オーバーレイ作成・切替               | `customer:create/switch` + 手編集                | B      | `scripts/company_onboarding.ts` プリセット                                                                              |
| **接続・設定**                           |                                                  |        |                                                                                                                         |
| サービス接続(Google/Slack/GitHub/…)      | `services:setup`(読取)+ OAuth 手順+vault 手編集  | **B**  | `service:preflight`、OAuth pipeline(callback :8787)、接続状態カタログ(pr653)                                            |
| 推論バックエンド確認・ロール束縛         | `reasoning:setup` / `reasoning:config bind-role` | B      | `scripts/reasoning_config.ts`(`.previous` バックアップ付き)                                                             |
| 通知チャネル設定                         | `pnpm kyberion notify --set slack:…`             | **A**  | `operator-notifications.ts` の load/save                                                                                |
| ガバナンスポリシー変更                   | `knowledge/product/governance/*.json` 手編集     | **C**  | **config-mission プリセット経由のみ**(`pnpm config-mission` 相当を API 化;直接 JSON 編集は GUI からもさせない)          |
| **日常業務**                             |                                                  |        |                                                                                                                         |
| 依頼(会話での仕事の依頼)                 | `pnpm kyberion ask` / 旧 3033 チャット           | **A**  | `runSurfaceMessageConversation` / voice-hub `/api/ingest-text`                                                          |
| 承認・差戻し                             | 既存(3050 で可)                                  | A      | 既存ルート(維持)                                                                                                        |
| 成果物の受領・修正依頼・プレビュー       | 既存(ただし `window.prompt`、プレビューなし)     | A      | [SU-03](../improvement-plans-2026-07/SU-03_DELIVERABLE_INBOX_REVIEW.ja.md) 残件のインラインプレビュー                   |
| 依頼状況・例外の確認                     | 既存                                             | 状況   | `buildCeoSurfaceSummary`                                                                                                |
| 停滞ミッションの判断(開始/中止)          | `mission-controller hygiene` → 手動判断          | **A**  | hygiene 分類結果を「伺い」カードとして提示。**判断は必ず人間のボタン/発話**                                             |
| 会議参加・議事録                         | `meeting:participate` / `minutes:record`         | C      | meeting preflight+mission 起票を会話から                                                                                |
| メール・カレンダー                       | `pnpm cli -- email/calendar …`                   | C      | email-workflow / calendar(送信は承認フロー必須を維持)                                                                   |
| 定期実行の確認                           | `schedule:list`                                  | 状況   | schedule registry の読み取り表示                                                                                        |
| **ナレッジ・拡張**                       |                                                  |        |                                                                                                                         |
| 文書の取込(ingest)                       | `pnpm ingest --tenant … --file …`                | **B**  | ドラッグ&ドロップ→`scripts/ingest.ts` 相当 API(`--ingested-by` は認証セッションから。自動監視取込はしない=現行思想維持) |
| 記憶昇格キューの承認                     | `mission-controller memory-approve/reject`       | B      | memory-promotion-queue の一覧+判断                                                                                      |
| プラグイン承認                           | `plugin:install` → `approvals` → 再実行          | B      | 既存承認ファネルに統合(3 手順を 1 画面に)                                                                               |

**非目標**: ビルド/テスト/registry ceremony 等の開発者業務、pipeline JSON の直接編集、mission_controller の全サブコマンド露出。

---

## 3. フェーズ計画

### CS-00: 土台の修復と資産回収(P0・最優先)

新機能の前に、壊れているものと消えそうなものを片付ける。

1. **pr653 worktree の未コミット実装を回収**: `/setup` 書き込み化+i18n+応答状況パネル(+941/−147、untracked 5 件)を専用ブランチにコミットし、本計画のフェーズ(CS-03/CS-04)に割り当てて再レビュー。i18n はそのまま採用せず CS-04 で方式判断。
2. **crash-loop 解消**: surface manifest に build ステップを保証(`surface_runtime` の `startupMode: workspace-app` に prestart build を追加するか、manifest args を `build && start` 相当に変更)。`pnpm surfaces:reconcile` 後に `/api/summary` が 200 を返すことを受け入れ条件とする。
3. **二重実装の解消方針決定**: Next.js 版(3050)を唯一の Concierge とし、Express 版(3033)は CS-01/CS-02 で会話・音声を移植完了後に削除。`CONCIERGE_AND_DASHBOARD_DESIGN.ja.md` の port/health 記述を更新(P8)。
4. `MSN-CONCIERGE-SECRETARY-20260802` の requirements blocking を本計画 §0 で解消し、ミッションを本計画の実行台帳とする。

**受け入れ条件**: reconcile 後にヘルスチェック連続成功/worktree に未コミット差分ゼロ/設計文書の記述が実態と一致。

### CS-01: 会話コア(P0)

秘書の本体。テキスト会話を登録サーフェスに実装する。

1. `POST /api/message` を Next.js 版に新設。旧 `server.ts:51-136` の **2 経路フェイルオーバー**(voice-hub `:3032 /api/ingest-text` → 不達時 lazy-import `runSurfaceMessageConversation`)をそのまま移植。
2. 応答は **SSE ストリーミング**(`streamPrompt` が使える経路では逐次表示)。30 秒ポーリングも SSE 化し、承認/成果物/例外の変化を即時反映(P5)。
3. 会話 UI は UX 契約の 4 会話形をコンポーネント化: Clarification(不足スロットの質問)/ Execution Preview(effect level `external_write` 以上は必ず事前提示→承認ボタン)/ Status Summary / Delivery Summary。**「次の一手」は必ず押せるボタン**(`suggested_command` の印字ではなく実行可能なアクション)。
4. `window.prompt` 廃止(修正依頼はインラインフォームへ)。
5. 書き込みは全て既存 `requireConciergeMutationAccess` を通し、contract test を拡張。

**受け入れ条件**: voice-hub 停止状態でも会話が成立(フェイルオーバー実証)/`direct_reply` と mission 昇格の双方が UI 上で区別して表示される/stub backend 時は stub-taint(`getStubServedOps`)を明示し実物の返答と誤認させない。

### CS-02: 音声(P1)

既存音声スタックの結線のみ。新規音声技術は作らない。

- **Tier 0(ブラウザ完結・依存ゼロ)**: 旧 `static/index.html:174-252` の `SpeechRecognition` + `speechSynthesis` 実装(約 50 行)を React 化して移植。マイクボタン→文字起こし→`/api/message`→応答読み上げ。
- **Tier 1(voice-hub 統合)**: voice-hub(:3032)稼働時は `/api/listen-once`(ネイティブ STT: mlx_whisper / Parakeet / Apple Speech)+サーバ側 TTS に自動昇格。`/api/stt/backends`・`/api/input-devices` を設定画面のデバイス/バックエンド選択に、`/api/speech/state`・`/api/stop-speaking` を発話中インジケータ+停止ボタンに接続。
- **Tier 2(リアルタイム対話)**: 本計画のスコープ外。[REALTIME_VOICE_CONVERSATION_PLAN](../improvement-plans-2026-07/REALTIME_VOICE_CONVERSATION_PLAN.ja.md) に委譲し、`/api/message` の契約を再利用できる形だけ担保。
- アバター: 旧 2.5D SVG アバター(5 状態)は**任意表示**として移植(設定でオン/オフ)。3D 化は既存設計文書 §4 に委譲し本計画では扱わない。

**受け入れ条件**: `test:ui-voice-browser-smoke` 系のスモークが Concierge に対して通る/Tier 0↔1 の切替がユーザ操作なしに機能する/`prefers-reduced-motion` と字幕(発話テキスト常時表示)でアクセシビリティを担保。

### CS-03: 秘書業務カタログの実装(P1〜P2)

§2 カタログの「方式 A/B/C」を順に実装する。**縦割りの原則**: 1 業務 = 1 API ルート + 1 UI + 1 contract test。全書き込みルートは `withExecutionContext('sovereign_concierge', …)` + `secureIo` 経由(pr653 実装が既にこの形)。

優先順(利用頻度×現行の痛み):

1. **セットアップウィザード**(P3 解消): 読み取り専用 `/setup` を、pr653 回収分(プロファイル・テナント・アバター・音声サンプル・サービス接続)をベースに書き込み対応へ。doctor/setup:report 相当の診断を「未完了項目→その場で直すボタン」として提示。
2. **通知チャネル設定**・**受領プレビュー**(SU-03 残件)。
3. **停滞ミッション伺いカード**(hygiene 分類の表示+人間の開始/中止ボタン。状態変更は必ず明示操作)。
4. **文書取込(ドラッグ&ドロップ ingest)**・**記憶昇格キュー**・**プラグイン承認の 1 画面化**。
5. **ガバナンス設定の config-mission 化**(GUI から直接 JSON を書かず、プリセット選択→config-mission 起票→承認、の governed 経路のみ提供)。
6. **会議・メール・カレンダーの会話起票**(方式 C)。

**受け入れ条件**: 各業務ごとに「CLI を使わず Concierge のみで完了できる」ことを E2E で実証/[CO-06](../improvement-plans-2026-07/CO-06_SOLOPRENEUR_AI_WORKFORCE.ja.md) の要件どおり CLI(`pnpm kyberion`)・Concierge・Chronos で件数が一致(action-queue projection の共有)。

### CS-04: UI/UX 刷新(P2)

1. **情報設計**: 「今日の伺い(承認・受領・例外・停滞判断を 1 本のキューに統合)」を最上部に、会話を常設(右または下部ドック)、業務カタログはコマンドパレット(⌘K)+ナビで到達。4 ペイン並列は廃止し「秘書が優先順に差し出す」導線へ。
2. **デザインシステム**: `createConciergeWebThemePack`(warm ivory/brass)を維持しつつ、コンポーネント層(ボタン/カード/フォーム/トースト)を整備。コントラストは `check_design_contrast.ts` ゲートを通す([DS-06](../improvement-plans-2026-07/DS-06_CHRONOS_LIGHT_THEME.ja.md) の再発防止)。
3. **i18n 方式の確定**(P6): 全体計画の共通語彙カタログ(`@agent/core`)方式に合流。pr653 のパッケージローカル `messages.json` は移行措置とし、I18N-04 の PARTIAL を解消。
4. **アクセシビリティ**: キーボード操作・スクリーンリーダ・字幕・`prefers-reduced-motion`。音声機能があるからこそ非音声代替を全機能に用意。

### CS-05: 品質・運用ゲート(P2、各フェーズに並走)

- contract test の拡張継続(mutation ルートの guard 網羅は operator-surface の `test:no-write-api` と対になる「write は必ず guard 経由」テスト)。
- surface health(reconcile→`/api/summary` 200)を first-win スモーク相当に追加し、P2 の再発を CI で防ぐ。
- 旧 Express 版削除・`static/index.html` 撤去・設計文書更新の完了をもって二重実装解消(P1)をクローズ。
- レビューフェーズで学びを `knowledge/` へ蒸留(dog-food)。

---

## 4. リスクと対応

| リスク                                 | 対応                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GUI 書き込みがガバナンスの抜け道になる | 全 mutation を authority role + effect level + 承認ファネルに通す。直接 JSON 編集 API は作らない(config-mission 経由のみ) |
| pr653 未コミット分の品質が未レビュー   | CS-00 で回収→通常レビューに載せる。採否はフェーズ内で判断(特に i18n 方式)                                                 |
| voice-hub 依存で音声が壊れやすい       | Tier 0(ブラウザ完結)を常時フォールバックとして維持。2 経路パターンは会話・音声とも必須                                    |
| スコープ肥大(CLI 全 GUI 化への誘惑)    | §2 カタログを唯一の到達目標とし、追加は本文書の改訂として合意してから                                                     |
| 他サーフェスとの役割侵食               | 実行機構の可視化要求は chronos へのリンクで返す(ceo-ux 契約の維持を contract test で固定)                                 |

## 5. 実装状況

- 2026-08-02: 計画作成。
- 2026-08-02: **CS-00 完了**(ブランチ `feat/concierge-secretary`)— pr653 worktree の未コミット実装(+2,171/−270、26ファイル)を `recover/concierge-pr653-scratch` 経由で回収・cherry-pick。crash-loop の根因(`build:ui` に concierge 欠落)を修正し `/api/summary` 200 を実証。設計文書に現況バナー追加。
- 2026-08-02: **CS-01 完了** — `POST /api/message`(voice-hub → orchestrator 2経路フェイルオーバー、3s タイムアウト、mutation guard)、`GET /api/events`(SSE、30s ポーリング置換)、ConversationDock(layout 常設、UX 契約 shape カード、i18n ja/en)、`window.prompt` 廃止。shape は orchestrator 結果から正直に導出(clarification/status_summary は捏造しない)。契約テスト 9 件。
- 2026-08-02: **CS-02 完了** — Tier 0(SpeechRecognition + speechSynthesis、字幕=interim を draft にミラー)、Tier 1(`/api/voice/status` 自動検出 → `listen-once` プロキシ、STT バックエンド/入力デバイス選択、発話状態の有界ポーリング+停止ボタン)。二重発話防止。契約テスト 10 件。**残**: 稼働 voice-hub に対するライブ E2E スモーク。
- 未着手: CS-03(業務カタログ実装。ただし回収した /setup 書き込み化・テナント CRUD・アバター/音声サンプル登録が先行実装として取り込み済み)、CS-04(情報設計刷新・i18n 方式合流)、CS-05(旧 Express 版削除ほか)。
