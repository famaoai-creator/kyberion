# AC-02: 未処理意図の解消と需要取り込みループの稼働

> 優先度: P1 / 規模: S〜M / 依存: なし / 関連: AC-01(能力申告)、KM-01(定期実行基盤)

## 背景と課題

需要(ユーザー発話)を能力拡張につなげる仕組み(`unhandled-intent-registry` + `scripts/reconcile_unhandled_intents.ts`)は存在するが、**回っていない**。レジストリには未処理のまま放置された高頻度意図が残り、提案ディレクトリ(`active/shared/tmp/unhandled-intent-proposals/`)は空。

`active/shared/tmp/unhandled-intent-registry.json` の未解消エントリ(2026-07-02 時点):

| 意図/発話                                                 | 種別                         | 回数     | 最終観測           |
| --------------------------------------------------------- | ---------------------------- | -------- | ------------------ |
| `inspect-mission-inventory`「ミッション一覧を教えて」     | unrouted(認識済み・経路なし) | **46**   | 2026-06-05         |
| `email-draft`「メール欄に『test@example.com』を入力して」 | unrouted + 誤マッチ          | **50**   | 2026-06-22(継続中) |
| "implement this change"                                   | unrecognized(意図なし)       | **51**   | 2026-06-05         |
| "hello" / "hello again" / "xyz123"                        | unrecognized(ノイズ/挨拶)    | 95/48/53 | —                  |

補足:

- `inspect-mission-inventory` は intent 認識まで到達しているが `intent-routing-map.json` に経路が無いだけ。ミッション一覧機能(`list_missions` 相当)は既存。
- `email-draft` 事例は実際には**ブラウザのフォーム入力**要求で、意図マッチング自体が誤り。関連して `page.fill: Timeout … locator('input[type=email]')` が 3 回(2026-07-01、直近)発生しており、ブラウザ入力の堅牢性も弱い。
- 挨拶ノイズは `continue-conversation` 意図が実装済み(intent-coverage-matrix)なのに閾値でこぼれている=マッチング調整の問題。

## ゴール(受入条件)

1. 上記の未解消エントリがすべて処置(ルーティング追加 / 意図追加 / ノイズ分類)され、レジストリ上で reconciled になる。
2. 「ミッション一覧を教えて」がミッション一覧を返す(E2E で確認)。
3. reconcile が定期実行(または review フェーズの標準ステップ)に組み込まれ、新規未処理意図が 1 週間以上放置されない構造になる。
4. 挨拶・雑談発話が `continue-conversation` に吸収され、unrecognized ノイズが減る。

## 実装タスク

### Task 1: 既知 4 系統の処置 — `claude-sonnet-4`

1. **inspect-mission-inventory**: `knowledge/product/orchestration/intent-routing-map.json`(および `intent-domain-ontology.json` の要件)にミッション一覧への経路を追加する。既存のミッション一覧手段(mission_controller の list / operator packet)のうちどれに紐づけるかは、`shape: task_session` の既存ルーティング例に倣う。E2E: `pnpm cli -- intent "ミッション一覧を教えて"` で一覧が返ること。
2. **email-draft 誤マッチ**: 「〜欄に…を入力して」系の発話を browser フォーム操作意図(既存の browser 系意図があるはず。無ければ `browser-fill-field` を意図オントロジーに追加)へ向ける。`email-draft` 意図の trigger 語彙から「入力して」系を外す。
3. **implement this change**: `code` ドメインに「変更実装」意図を追加し、task session(code-actuator / 開発ループ)へ振る。確信度が足りない場合は明確化質問(「どのファイル/リポジトリに対する変更ですか」)に落とす経路を明示。
4. **挨拶ノイズ**: 意図マッチャの閾値・トリガーを調整し "hello"/"こんにちは" 系を `continue-conversation` に確実に入れる。`xyz123` のような無意味入力は「理解できなかった + 言い換え依頼」の定型(UX-06 Task 4 と整合)へ。
5. 各処置後、`scripts/reconcile_unhandled_intents.ts` を実行してレジストリを reconciled に更新する。

### Task 2: browser フォーム入力の堅牢化(小規模)— `claude-sonnet-4`

- `page.fill` timeout 3 件の trace を確認し、browser-actuator の fill 系 op にフォールバック(ラベルテキスト・placeholder・name 属性による多段ロケータ解決と、失敗時の「見つかった入力欄候補一覧」を含むエラー)を実装する。網羅的なセレクタ戦略の再設計はしない(±100行程度)。

### Task 3: 需要取り込みループの定常化 — `claude-sonnet-4`

1. `reconcile_unhandled_intents` を review フェーズ(`knowledge/product/governance/phases/review.md` のチェックリスト)と、KM-01 で導入する週次パイプライン(`weekly-review.json`)のステップに追加する。
2. reconcile 実行時、未解消件数と top 発話を operator packet / 週次サマリに 1 行で出す(「未処理意図が N 件あります」)。
3. レジストリの `occurrences` 集計が上書きでなく累積であることを確認し、reconciled エントリのアーカイブ(レジストリ肥大防止)を追加する。

### Task 4: 検証 — `claude-haiku`

- Task 1 の 4 発話を `pnpm cli -- intent` で実行し、期待経路に乗ることを確認。レジストリが空(または reconciled のみ)になっていることを確認して報告。

## リスクと注意

- 意図オントロジー(`intent-domain-ontology.json`、131 意図)への追加は `check:intent-domain-coverage` の整合検査対象。actuator/テンプレート/outcome への参照を揃えないと validate が落ちるため、既存意図のエントリを雛形にする。
- 閾値調整は他意図の誤マッチを誘発し得る。変更前後で意図マッチングの回帰テスト(既存の intent 系テストを確認、無ければ代表 20 発話の fixture テストを追加)を回す。

## 実装状況 (2026-07-03)

- **完了**: `scripts/reconcile_unhandled_intents.ts` が top 未解消発話と summary line を出力し、`active/shared/tmp/unhandled-intent-last-run.summary.txt` を書くようになった。
- **完了**: `scripts/run_pipeline.ts` の `system:shell` が JSON stdout を structured context に反映するようになり、シェル由来の reconcile 結果を次ステップで扱える。
- **完了**: `pipelines/reconcile-unhandled-intents.json` は summary-only logging に整理され、`knowledge/product/governance/phases/review.md` と `pipelines/weekly-review.json` に review フローとして接続された。
- **検証済み**: `pnpm exec vitest run scripts/run_pipeline.test.ts`、`pnpm pipeline --input pipelines/reconcile-unhandled-intents.json`、`pnpm run build:repo`、`pnpm run typecheck`、`pnpm lint`、`git diff --check`。

## 実装状況 追記 (2026-07-12)

- **browser fill フォールバック完了**: `fillWithFallback`(±100行の計画スコープ内)— セレクタ直 → label(`params.field` ヒント or セレクタが平文の場合はそれ自体)→ placeholder → name 属性の多段解決。全滅時は**ページ上の入力欄候補一覧付きエラー**(修復エージェント/操作者がページを開き直さず修正可能)。フォールバック成功時は `fallback_strategy` を action trail に記録。テスト4本(直/label/平文ヒント/候補一覧エラー)。
- 残: 4系統 reconciled 化の E2E(意図オントロジー側)。
