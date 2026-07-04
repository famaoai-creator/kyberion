# UX-03: 言語一貫性 — 「日本語既定のオペレータに英語ハードコード」の解消

> 優先度: P1 / 規模: M〜L(段階実施) / 依存: なし / 関連: UX-05(契約の code 化)、[DOCUMENTATION_LOCALIZATION_POLICY](../../DOCUMENTATION_LOCALIZATION_POLICY.md)

## 背景と課題

システムの言語契約が**反転**している: オペレータの既定言語は日本語(`onboarding_wizard.ts:227` の identity 既定 `language: 'Japanese'`、surface-ux-contract のテストは日本語運用文言を要求 `libs/core/surface-ux-contract.test.ts:5-53`)なのに、ターミナル・UI の実文言はほぼ英語ハードコード。一方で局所的に日本語ハードコードが英語ロケール利用者に出る箇所もある。ローカライズ機構(`t()`、`user-facing-vocabulary.json` の en/ja ペア)は存在するが、配線されているのは約15語のみ。

### 代表的な証拠

- **オンボーディング全文英語**: `scripts/onboarding_wizard.ts:278-284,316-353,433-459,505-509,613,622`。フェーズ名も英語単一文字列(`knowledge/product/governance/onboarding-flow-policy.json:3-14`、locale マップ無し)。
- **cli.ts**: `t()` は存在する(`:199-204`)が `printOperatorPacket` 等のラベル約15語のみ。`printHelp`(`:294-361`)・全エラーメッセージは英語固定。`--locale ja` はほぼ機能しない。
- **明確化質問が英語生成**: `libs/core/question-resolver.ts:162-166,395-400,453-454`(`Please provide ...` / `More context is required before execution`)。日本語で依頼したユーザーに英語の質問が返る。
- **chronos の EN/JA 混在**: `page.tsx:102-210`(Quick Action 群・ステータスカードが英語固定)vs `page.tsx:422-428`(hero が日本語固定)。`FirstRunBanner.tsx:68-78` 英語固定。`SovereignChat.tsx:18-35,208,233` 英語固定。**言語切替 UI が無く** `navigator.language` のみで決まる(`src/lib/hooks.ts:10-18`)。
- **`uxText` の fallback 文字列がカタログと乖離**(死んだ文言): `SovereignChat.tsx:226-229,293`。
- **operator-surface / presence-studio / computer-surface**: i18n ゼロ(presence-studio の状態語 "Ready/Error/Listening" は `static/index.html:718,1099,1193` 等で英語固定)。
- **surface-interaction-model の既定通知タイトルが英語固定**(`:254,265,276` — UX-02 Task 5 で対応)。

## 方針

全文言の一括翻訳はしない。**「オペレータが日常的に目にする面」から順に、語彙カタログ経由に寄せる**。カタログに無い自由文はロケール別テンプレート(en/ja)をコード近傍に持つ。

## ゴール(受入条件)

1. ロケール解決が一元化される: 優先順位「明示指定(`--locale`/UI 切替)→ onboarding identity の `language` → OS/ブラウザ」の関数が `@agent/core` に 1 つ存在し、CLI・chronos・ブリッジが共用する。
2. chronos に言語切替(en/ja)が付き、選択が永続化される。
3. 明確化質問・オンボーディング・cli.ts のヘルプ/主要エラーが ja/en 両対応になる。
4. `uxText` のコード側 fallback とカタログの乖離が解消される(fallback はカタログと同文をコピーせず、キー欠落を検知する lint/テストで守る)。

## 実装タスク

### Task 1: ロケール解決の一元化 — `claude-sonnet-4`

1. `libs/core/locale-resolver.ts` を新設: `resolveLocale({ explicit?, identityPath? }): 'ja' | 'en'`。identity(`my-identity.json` の `language`)の読み込みは secure-io 経由。unit test 付き。
2. `cli.ts:156-167` の `--locale` 処理、chronos の `hooks.ts:10-18`(API 経由で identity を引けない場合は localStorage 永続の明示選択を優先)、ブリッジの `delegationSummaryInstruction` をこの関数の結果に接続する。

### Task 2: 明確化質問の ja/en 化(効果最大)— `claude-sonnet-4`

1. `question-resolver.ts:162-166,395-400,453-454` の英語固定文をテンプレート化し、語彙カタログに `question_*` エントリ(en/ja)を追加して引く。動的部分(`${input}`)はプレースホルダ差し込み。
2. `surface-ux-contract.test.ts` の日本語要件と整合することを確認し、`question-resolver` のテストに locale 別スナップショットを追加。

### Task 3: オンボーディングの ja/en 化 — `claude-sonnet-4`

1. `onboarding-flow-policy.json` のフェーズ文字列を `{ en, ja }` オブジェクトに拡張(スキーマと読み手 `onboarding_wizard.ts` を同時更新。後方互換: 文字列なら en とみなす)。
2. wizard のプロンプト(`:278-284` ほか)をロケール別テンプレートに置換。最初の質問(言語選択)だけは両言語併記で表示する。
3. 非対話拒否メッセージ(`:582-596`、現状最良のエラー文)も ja 版を用意。

### Task 4: cli.ts の help / 主要エラーの ja/en 化 — `claude-sonnet-4`(文言表の作成)→ `claude-haiku`(置換の横展開)

1. sonnet: `printHelp`・エラーメッセージを棚卸しし、「キー / en / ja」の文言表を作り語彙カタログへ追加(`check:catalogs` 通過を確認)。
2. haiku: 表に従って `t()` 呼び出しへ機械的に置換。1 コマンド群ごとに `pnpm cli -- help` 目視 + 既存テスト実行。

### Task 5: chronos の言語切替と混在解消 — `claude-sonnet-4`

1. ヘッダに en/ja トグルを追加し、選択を localStorage に永続化(Task 1 の優先順位に組み込む)。
2. `page.tsx` の Quick Action 群・ステータスカード・hero、`FirstRunBanner.tsx`、`SovereignChat.tsx` の固定文言を `uxText` + カタログ追加で両対応にする。hero の日本語文は en 版を書き起こす。
3. `uxText` fallback 乖離(`SovereignChat.tsx:226-229,293`)は fallback を撤去してキー必須にし、キー欠落を検出するテスト(カタログとコード内キーの突合)を `src/lib/ux-vocabulary` に追加する。

### Task 6: 残面の扱いを決めて記録 — `claude-haiku`

- operator-surface(意図的 read-only・開発者向け)と presence-studio/computer-surface は本 IP では対象外とし、本文書末尾に「未対応面リスト」として明記する(将来の判断材料)。presence-studio の状態語 3 つ(Ready/Error/Listening)だけはカタログ語彙に合わせて ja 対応してよい(静的 HTML 内の文字列置換で完結するため)。

## リスクと注意

- 文言変更はスナップショットテスト・文字列マッチの既存テストを壊しやすい。**キー化 → 既定ロケールでは従来文言と同一** を原則にし、テスト修正は文言変更を伴うものだけに限定する。
- LLM が生成する自由応答の言語は「ユーザーの言語で返す」プロンプト指示(slack-bridge `:267-268` の方式)に統一し、chronos の日本語固定指示(`api/agent/route.ts:1135`)も同方式へ合わせる。

## 実装メモ

- `libs/core/question-resolver.ts` の固定英語文を `knowledge/product/orchestration/user-facing-vocabulary.json` の `question_*` キー経由に置換した。
- `question-resolver.test.ts` に ja/en の期待値を追加し、明確化質問のロケール差分を固定した。
