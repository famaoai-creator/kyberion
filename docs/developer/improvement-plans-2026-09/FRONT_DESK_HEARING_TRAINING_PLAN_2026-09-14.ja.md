---
title: FRONT DESK HEARING TRAINING PLAN 2026 09 14
tags: [improvement-plan, 2026-08, surface, ux, hearing, training, companion-hub]
last_updated: 2026-09-14
status: active
---

# ヒアリングエージェントとトレーニング計画(HT-00〜HT-06)— Companion Hub の後継

> **作成日**: 2026-09-14
> **対象**: 相棒(presence-studio :3031)に載せる 2 つの利用者向け機能 — (1) 顧客要求を汲み取る**ヒアリングエージェント**(当面は Web アプリ作成シナリオ。キャンバスで動くビューを見せながら聞く)、(2) AI の使い方をレベル別に教える**トレーニング**(組織展開用)。加えて PR #736(`fix/personal-workbench-governance`)の Companion Hub 資産の扱い。
> **前提**: [FRONT_DESK_REDESIGN_PLAN](./FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md)(FD-00〜09 実装済み: 共有レール、`/ask` の会話 API、intent resolution の描画、メンバー登録簿)。**新しい surface は増やさない**。
> **ステータス表記**: 各フェーズ末尾の「実装状況」節に記録(07 月次規約と同一)

---

## 0. 目的と判断基準

1. **ヒアリング**: 利用者(または利用者の顧客)が「作りたいもの」を言葉にできない段階から、相棒が質問を重ね、その場でキャンバスに見せ、要件レコードに固める。成果は既存の alignment gate(report-review :8137)→ mission の流れに乗る。人が「見て直す」ことで要件が決まる、という体験を最優先にする。
2. **トレーニング**: AI の使い方がわからない人が、レベル別のトラックを順に「やってみる → できたことを確認する」で身につける。組織展開では、オーナーがテナントのメンバーにトラックを割り当て、進捗を見られる。
3. 両方とも[USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md)の 4 概念(依頼 / 実行単位 / 成果物 / 次の一手)と、FD 計画 §0 の禁止(英語ラベル・ポート番号・内部語を人の画面に出さない)を守る。

## 1. Companion Hub(PR #736)の評価

| 資産                                                    | 中身                                                                                              | 評価                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `companion-learn-catalog.json` + schema                 | ギャラリー 5 件(試すヒントは CLI コマンド)、初心者ガイド 3 件(`audience`、`steps`、`doc`)         | **データ形は活かす**(HT-04 のトラックカタログの種)。CLI ヒントは人向け画面の規約に反するので、画面内の操作に置き換える。 |
| `learn.html` / `hub.html` / `companion-nav.js` / `.css` | 独立メニュー Learn / Discover / Connect / Work                                                    | **活かさない**。FD-00〜08 で共有レールに置き換え済み。                                                                   |
| `DiscoverDraft`(`companion-hub.ts`)                     | `scenario: web_app_build`、要件 7 項目 + 備考、viewer スコープ別の保存先、alignment gate への案内 | **記録形は活かす**(HT-02 の要件レコードの基底)。会話・追加質問・キャンバスが無いのでフォームとしては使わない。           |
| `discover.html`                                         | URL 入力 + チェックリスト + 手元ミラーへのリンク                                                  | **活かさない**。                                                                                                         |
| MCP facade(`f153601b0`)、OAuth 開始ルート               | 本計画の対象外                                                                                    | 独立した価値。OAuth 側は #735 に移植済みなので重複解消が必要。                                                           |

**#736 の扱い**: #735 マージ後に rebase し、Hub のページ類を落として (a) カタログ + schema、(b) `DiscoverDraft` の型と保存ロジックを knowledge / libs 側の資産として残す。MCP facade はそのまま。作業は HT-00 で行う。

## 2. 設計

### 2.1 置き場(共有レール上)

| 機能         | 入口                                                               | 画面                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ヒアリング   | 「頼む」のチップ「Webアプリの要望をまとめる」→ `/ask?mode=hearing` | 左: 会話(既存 `/api/conversation`)。右: **キャンバス**(生成した HTML を iframe で描く。会話のたびに更新)。下: 「わかったこと」カバレッジ表(要件レコードの項目が埋まるほど進む)。 |
| トレーニング | レール左下「使い方を見る」→ `/help`(トラック一覧)/ `/help/<track>` | トラック(初級 / 中級 / 上級)→ レッスン(1 画面 1 つ: 説明 → やってみる(実際の「頼む」を開く)→ できたことの確認)。進捗はメンバー単位。                                             |
| 組織展開     | 秘書室「設定 › 組織とメンバー」                                    | テナントのメンバーにトラックを割り当て、進捗(未着手 / 進行中 / 完了)を一覧。                                                                                                     |

### 2.2 ヒアリングの部品(既存の再利用)

- **質問の源**: intent resolution の `missing_inputs` と `next_action`(FD-03 で描画済み)。要件レコードの未充足項目を `missing_inputs` に写像し、相棒が次に聞く。
- **キャンバス**: 発見・創作は scratch first([scratch-to-pipeline-video-promotion](../../../knowledge/product/orchestration/scratch-to-pipeline-video-promotion.md) と同じ形)。会話ごとに `active/shared/tmp/hearing/<session>/canvas.html` を生成し、`/api/hearing/:session/canvas` で配信、iframe(`sandbox`、外部リソース無し)で描く。デザインは `resolveCreativeDesign` + design-defaults に委ね、要素ごとのスタイル直書きはしない。
- **要件レコード**: `DiscoverDraft` を拡張した `HearingRecord`(`scenario`、`requirements[{id,label,answer,confidence,source_turn}]`、`canvas_versions[]`、`decided_by`)。保存先は viewer スコープ別の `active/shared/tmp/hearing/`。確定時に alignment gate へ渡し、受理されたら mission へ。
- **顧客同席**: 利用者の顧客が同席する場合も画面は同じ。記録の `actor` は同席者ではなく利用者(メンバー)。同席者の識別は本計画の対象外(FD-10 のアクター語彙で将来 `on_behalf_of` を使う)。

### 2.3 トレーニングの部品

- **カタログ**: `knowledge/product/orchestration/training-catalog.json`(schema 付き)。`tracks[{id, level, title, audience, lessons[{id, title, goal, try: {kind: 'ask'|'decide'|'progress'|'settings', prefill?}, check: {kind: 'self'|'artifact'|'decision', text}}]}]`。#736 の `guides` を初級トラックに移し、`gallery` は「やってみる」の例に写す。
- **進捗**: `knowledge/personal/members/<member_id>/training.json`(メンバー登録簿の隣。tier は personal)。`lesson_id → {status, completed_at, evidence?}`。
- **割り当て**: テナント単位の `knowledge/confidential/<tenant>/training/assignments.json`(オーナーのみ書ける)。
- **語彙**: `front_desk` ドメインに `training_*` を追加。レッスン本文は語彙ではなくカタログ(自由文)。

### 2.4 実装上の原則

- ページは FD-02〜05 と同じ静的 HTML + 純関数 + viewer スコープの読み取りルート。ファイルは 1500 行以内(`pnpm check -- --only max-file-lines`)。
- 語彙は `user-facing-vocabulary.json`(`pnpm check -- --only catalogs`)。
- 書き込みはすべて localadmin(オーナー / 承認者)のみ。キャンバス HTML は生成物であり、利用者入力をそのまま埋め込まない(escape + iframe sandbox)。

## 3. フェーズ計画

### HT-00: #736 の整理(P0)

1. #735 マージ後に #736 を rebase。Hub ページ類を削除、`companion-learn-catalog.json` + schema と `DiscoverDraft` の型 / 保存ロジックを残す(ページから参照されない状態にしてもテストが通るように整理)。OAuth 開始ルートの重複を解消(#735 側を正)。
2. `docs/SURFACES.md` の記述を FD-08 版に合わせる。

### HT-01: ヒアリングモードの骨格(P1)

`/ask?mode=hearing`: 右カラムをキャンバス枠 + カバレッジ表に切り替える。`GET /api/hearing/:session`(レコード読み取り)、`POST /api/hearing/:session/answer`(会話ターンから項目を更新。純関数 `applyHearingTurn`)。キャンバスはまず「要件の見出しカード」だけを描く固定テンプレートで開始し、モデル生成は HT-02。

### HT-02: キャンバス生成(P1)

会話ごとに `canvas.html` を生成(semantic brief → `resolveCreativeDesign` → HTML)。バージョンを残し、「前の案に戻す」を用意。利用者の「ここを変えて」を次のターンの入力に含める。

### HT-03: 確定と受け渡し(P1)

「この内容で進める」→ `HearingRecord` を alignment gate(report-review)に渡し、受理で mission 作成(既存 `mission_controller` 経由、`decided_by` 付き)。進み具合に「要件確定済み」の項目として出る。

### HT-04: トレーニングカタログと `/help`(P2)

`training-catalog.json` + schema、`/help` をトラック一覧に、`/help/<track>` をレッスン画面に。`try` は実際の「頼む」「決める」を prefill で開く。進捗はメンバー単位。

### HT-05: 組織展開(P2)

設定 › 組織とメンバーにトラック割り当てと進捗一覧。テナントの assignments を governed facade 経由で書く。

### HT-06: 品質ゲート(各フェーズに並走)

契約テスト(権限 / narrowing / 内部語なし / iframe sandbox)、Playwright スクリーンショット、`pnpm check` 全ゲート。

## 4. リスクと対応

| リスク                              | 対応                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| キャンバス生成が遅く会話が止まる    | 生成は非同期。前バージョンを表示したまま「更新中」を出す。固定テンプレート(HT-01)を先に。      |
| 生成 HTML の安全性                  | iframe `sandbox`、外部リソース禁止、利用者入力は escape。`/api/hearing/*` は同一 viewer のみ。 |
| トレーニング内容が陳腐化する        | レッスンは「実際の画面を開く」形にして、説明文を最小にする。                                   |
| #736 の rebase で MCP facade と衝突 | HT-00 を独立 PR にし、Hub 削除と facade を分けてレビューする。                                 |

## 5. 実装状況

- 2026-09-14: 計画作成(#736 の評価と、FD 計画上の置き場を確定)。
- 2026-09-14: **HT-01 部分実装** — `presence/displays/presence-studio/hearing.ts` にシナリオ定義から要件レコードを生成する純関数、会話ターン適用、充足率計算を追加。Web アプリ要件 7 項目はデフォルトとして維持し、シナリオごとに項目・表示名・別名を差し替え可能にした。空ターンから回答を捏造しない契約を 3 テストで固定。UI/API の接続とキャンバス生成は未着手。
- 2026-09-14: **HT-01/HT-02 第1段** — `/ask?mode=hearing` の会話横キャンバス、viewer スコープ付き `GET /api/hearing/:session` / `canvas`、localadmin 限定の回答更新を接続。キャンバスは外部リソースなし・escape 済み・sandbox iframe で描画し、回答ごとの `vN` HTML を `active/shared/tmp/hearing/` に保存して過去版を `?version=vN` で再表示できる。alignment gate、確定受け渡し、トレーニング、組織展開、公開経路への KA-06 接続は未完了。
- 2026-09-14: **HT-03 第 1 段 / HT-04 / HT-05 第 1 段** — `POST /api/hearing/:session/decide`(全項目回答済みのときだけ、`decided_by` = 解決したメンバー `user:<member_id>`、未登録 principal は 403、次の一手は語彙キー)。`libs/core/training-catalog.ts` + `training-catalog.json`(schema 付き)、`/help` のトラック一覧と `/help/<track>` のレッスン、メンバー単位の進捗(`GET/POST /api/training/progress`)、テナント単位の割り当て(`/api/training/assignments`、秘書室の設定 › 組織とメンバーから割り当て)。**未完了**: alignment gate への受け渡しと mission 作成(HT-03 後半)、キャンバスのモデル生成(HT-02 はテンプレート描画 + バージョン保存まで)、KA-06 の公開経路接続、進捗一覧の表示。
- 2026-09-14: **HT-02 / HT-03 後半 / HT-04・05 第 2 段(ブランチ `agent/front-desk-ht2-20260914`)** — (HT-02) `hearing-canvas.ts`: 要件レコードから意味ブリーフ → `resolveCreativeDesign({surface:'web'})` のトークン → 推論バックエンドに 1 通の指示(20 秒でタイムアウト)→ サニタイズ(単一 `<html>` 文書、タグ許可リスト、script / handler / src / href / url / import / iframe / form 禁止、200KB 上限)。失敗時はテンプレートに戻る。`/answer` はテンプレート版を同期保存してから非同期生成し、レコードの `canvas_generation` を pending → generated / template と進める(同一セッションの重複生成は合流、最新回答が勝つ)。実機(claude-cli)で生成 → サニタイズ → 配信を確認。(HT-03) `POST /api/hearing/:session/handoff`: 確定済みレコードから schema 準拠の mission brief を作り、`mission_controller create`(`--goal` / `--success-condition` / `--tier confidential` / `--tenant-slug` / `--decided-by user:<member_id>`)→ ディスク上で `planned` を検証 → `evidence/mission-brief.json` → `mission_alignment_request --mission` で `mission_gate` 承認を開き、`mission_id` / `approval_request_id` をレコードへ。承認は「決める」側。冪等。(HT-04/05) `/help` の「できた」ボタン、`summarizeTrainingProgress`、オーナー限定・テナント絞りの進捗一覧(相棒 `/api/training/progress/overview`、秘書室 `/api/training/progress`)、設定 › 組織とメンバーに `{done}/{total} レッスン`。
  - **修正**: `--decided-by*` が `libs/core/mission/mission-types.ts` の VALUE_FLAGS に無く、`create` と併用すると位置引数が崩れていた。相棒サーバが起動時に `installReasoningBackends()` を呼んでおらず常に stub だった(`server.ts` で登録)。
  - **残件**: mission brief の書き込みは surface が `withExecutionContext('mission_controller')` に昇格して直接書いている(`mission-coordination-bus.ts` と同じ既存パターン)。FD-10 原則 2 に沿って `mission_alignment_request --brief <path>` のような governed な受け口を作り、surface の昇格をなくす。ヒアリング完了後の「決める」側でのブリーフ表示(承認カードに brief の要点を出す)は未着手。
- 2026-09-14: **ブラウザ実機 QA と不具合修正**(Playwright で 相棒 :3031 / 秘書室 :3050 を操作)。見つかった不具合と対処:
  - **秘書室(決める / 設定)が全滅**: (a) `next start` が古いビルドを配信しチャンク 500(`ChunkLoadError`)→ 再起動で解消。(b) Next.js は `NextRequest.ip` を持たないため loopback 判定が常に偽で全 API が 401 → `KYBERION_CONCIERGE_LOOPBACK_BIND=true`(`-H 127.0.0.1` バインドの宣言。manifest に既定で付与)で localadmin 解決。契約テスト 2 件追加。
  - **全ページが 3〜6 秒**: `compileSchema` が呼び出しごとに Ajv を新規生成して同じスキーマを再コンパイル(レコード 1 件あたり約 100ms)。`foundation/ajv.ts` に path+mtime キーのコンパイル済みキャッシュを追加 → `listTaskSessions` 2.06s→0.24s、`/api/me` 3.4s→0.05s、`/api/progress` 3.0s→0.35s、`/api/home` 3.3s→1.0s(残りは `listApprovalRequests` 512 件 0.65s)。
  - **ヒアリングのキャンバスが更新されない**: クライアントが `record.canvas_url` を見ていたが URL は応答のトップレベルにあり、かつ URL が不変で iframe が再読込されなかった → サーバが `?version=vN&locale=` 付き URL を返し、クライアントは応答の `canvas_url` を保持。回答後にキャンバス状態のポーリングも再開。
  - **会話ごとに数値だけ増える**: 一般会話経路(intent routing)がヒアリングの答えを「依頼」として解釈し、不足入力の内部 ID を返していた → ヒアリングは「質問→答え」の列に変更。`asked_id` を持ち、答えは聞いた項目に着地、相棒の次のターンは次の未回答項目(`next_question` / `prompt`)。開いた直後に最初の質問を出す。一般会話経路は呼ばない。
  - **「頼む」の返答に内部語・生エラー**: 不足入力の ID(`goal_or_target`)を平文化、カレンダー読取失敗時の osascript エラー本文を返さない、ナレッジ検索の返答からプロバイダ内部名を除去。**未解決**: intent 解決の誤分類(「議事録テンプレート」→カレンダー読取、「今日やること 3 つ」→ナレッジ検索)と 55〜89 秒かかるオーケストレータ経路は intent-resolution 側の課題として残る。
  - **運用上の落とし穴**: surface は detached(親 launchd)で起動しているため、`pnpm build` 後も古いコードのまま動き続ける(相棒・voice-hub・秘書室すべて該当)。ビルド後は該当 surface の再起動が必要。
  - **再確認後も残るもの**: 「頼む」の一般会話で `schedule-read-agenda` に振られた依頼が、voice-hub のロール(`SYSTEM_ROLE=voice_hub` / `MISSION_ROLE=surface_runtime`)では `knowledge/personal/contextual-intent-learning.json` を読めず `[ROLE_VIOLATION]` で失敗する(利用者には汎用文言を返すよう修正済み。権限の広げ方は governance 側の判断)。秘書室の `/api/voice/selection` と `/api/training/catalog` が初回 503 を返すことがある(依存先 surface の起動順)。相棒の表示は 3〜6 秒 → 0.8〜1.5 秒、ヒアリングは 1 ターン約 0.45 秒。
- 2026-09-14: **2 回目の実機 QA(利用者報告: 「頼む」が考えています のまま / テナントが default から動かない / カメラ無反応 / ヒアリングを埋めても登録できない)**
  - **「頼む」の固まり**: voice-hub 先行 + 3 秒打ち切り → voice-hub は同じオーケストレータを回した上で TTS 完了まで応答しないため毎回タイムアウト → 相棒側でオーケストレータを**二重実行**(50〜90 秒)。相棒はオーケストレータを 1 回だけ回し、voice-hub には `auto_reply:false` で反射だけを投げる(待たない)形に変更。voice-hub 自体は `installReasoningBackends()` を呼んでおらず stub だったので登録。さらに直接回答経路が個人 tier(学習メモリ・カレンダー既定)の読み書きを前提にしており、surface の role では `ROLE_VIOLATION` で返答ごと落ちていた → 学習・既定メモリの読み書きを probe-and-degrade(best effort)に。
  - **テナント切替**: ローカル閲覧者が `KYBERION_TENANT` に固定され(`loopbackUsesServerTenant`)、オーナーの 7 テナント所属が使われていなかった。相棒・秘書室ともにローカルのオーナーは所属テナント全部を一覧し、`?tenant=`(ページが localStorage の選択を全 API に付与)で narrowing、未指定時はサーバ既定テナント、という FD-01 の意図に修正。契約テスト追加。
  - **ヒアリングの登録失敗**: surface は `SYSTEM_ROLE=<surface>` で起動され、governed CLI(`mission_controller create`)に `MISSION_ROLE=mission_controller` だけ渡していたため、`resolveRole()` が SYSTEM_ROLE を優先して surface の role で実行 → exit 1。`SYSTEM_ROLE` も渡すよう相棒の handoff と秘書室の hygiene / memory-queue を修正。失敗時は controller の stderr を運用ログに残す。修正後は決定 → mission 作成 → alignment 承認まで通る(QA で作った `MSN-HEARING-QATEST1` / `MSN-HEARING-E41D3063` は cancel 済み)。
  - **カメラ**: 失敗理由(権限拒否など)は画面上部の通知にだけ出ていて、ボタンの近くでは「何も起きない」に見えた → ボタン直下にインライン表示を追加。実カメラの動作は headless では未検証。
  - **フェーズ式ヒアリングシート**(利用者要望): `knowledge/product/orchestration/hearing-scenarios.json`(schema・catalog integrity 登録)に「Web アプリの要望」(目的 / 中身 / 制約と成功条件)と「業務のやり方を改善する」(現状 / 困りごと / あるべき姿)の 2 シートを定義。相棒は質問をフェーズ単位で進め(「目的について、次に『対象となる人』を教えてください」)、進捗をフェーズ別に表示、キャンバスもフェーズ見出しで描く。「頼む」のチップからそれぞれのシートを直接開ける。
