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
