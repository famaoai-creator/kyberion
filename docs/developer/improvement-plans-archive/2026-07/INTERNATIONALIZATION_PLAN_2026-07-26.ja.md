---
title: INTERNATIONALIZATION PLAN 2026 07 26
tags: [improvement-plan, 2026-07]
last_updated: 2026-07-31
status: archived
---

# 国際化・多言語対応計画 2026-07-26(I18N-01〜08)

> **作成日**: 2026-07-26
> **根拠**: リポジトリ全体の実測調査(語彙カタログ・ロケール解決経路・コード内文言リテラル・書式 API・LLM 出力言語・enforcement の6観点)
> **位置づけ**: [UX-03 言語一貫性](./UX-03_LANGUAGE_CONSISTENCY.ja.md)(DONE / ja↔en の一貫性回復)の**後続計画**。UX-03 が「日本語オペレータに英語が出る」を直したのに対し、本計画は **「第3言語をデータ追加だけで足せる状態」への構造転換**を扱う。
> **関連**: [DOCUMENTATION_LOCALIZATION_POLICY](../../../DOCUMENTATION_LOCALIZATION_POLICY.md)(語彙ルールの正本)、[UX-05 UX 契約の enforcement](./UX-05_UX_CONTRACT_ENFORCEMENT.ja.md)、[DS-03 日本語タイポグラフィ](./DS-03_DOCUMENT_THEME_JP_TYPOGRAPHY.ja.md)
> **実装状況の正本**: [STATUS.ja.md](../../improvement-plans-2026-07/STATUS.ja.md)

## 1. 結論(先に読むべき3点)

1. **基盤はある**。`user-facing-vocabulary.json` は **305 キー / en・ja 完備 / 欠落 0**、JSON Schema はロケール open(`additionalProperties: {type: string}`)。**カタログ構造を変えずに第3言語を足せる**。
2. **配線が割れている**。ロケール解決が **5系統**、環境変数が **3つ**、既定値が `ja` と `en` に**割れている**。型 `'ja' | 'en'` が **22箇所**にハードコードされており、第3言語を足すと**型エラーで壊れる**。
3. **止血できていない**。非テスト実装ファイル **139 ファイル / 約 1,975 行**にコード直書きの日本語が残り、新規ハードコードを止める lint は**存在しない**。放置すると翻訳作業が永久に追いつかない。

> よって本計画は「翻訳を足す」ではなく、**①言語を1箇所で決める → ②文言をコードから出す → ③新規ハードコードを入れさせない → ④第3言語で実証する** の順で構造から直す。

## 2. 現状(実測エビデンス)

### 2.1 語彙カタログ — 資産として健全

| 項目             | 実測                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| キー数           | 305(domain は `ux` の1つのみ、フラット)                                                    |
| ロケール網羅     | en 305 / ja 305 — **欠落 0**                                                               |
| キー接頭辞の分布 | `chronos` 143 / `cli` 87 / `error` 19 / `mission` 10 / `question` 8 / `connection` 8 / 他  |
| プレースホルダ   | **7 キーのみ**(`question_provide`, `cli_error_unknown_command` ほか)。書式規約は未定義     |
| スキーマ         | `knowledge/product/schemas/user-facing-vocabulary.schema.json` — ロケールは open(拡張可能) |
| 整合性検査       | `scripts/check_catalog_integrity.ts:197-217` — **`default_locale` の存在しか見ない**       |

**問題**: 検査が default_locale のみのため、**`ja` が欠けたキーを CI が通してしまう**。第3言語を足しても「翻訳漏れ」が検知されない。また domain が `ux` 1つのフラット 305 キーで、`chronos` 143 キーが CLI 用キーと同じ名前空間に同居している。

### 2.2 ロケール解決 — 5系統が並存し、既定値が割れている

| #   | 実装                                                                               | 優先順位                                          | 既定     |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| 1   | `resolveOperatorLocale()` `libs/core/operator-identity.ts:30`                      | `KYBERION_LOCALE` → identity の `language` → 引数 | **`ja`** |
| 2   | `resolveVocabularyLocale()` `libs/core/ux-vocabulary.ts:97`                        | 引数のみ(呼び出し側が `process.env.LANG` を渡す)  | **`en`** |
| 3   | `resolveLocale()` `scripts/cli.ts:171`                                             | `--locale` → `KYBERION_UI_LOCALE` → `LANG`        | **`en`** |
| 4   | `resolveQuestionLocale()` `libs/core/question-resolver.ts:100`                     | `KYBERION_UI_LOCALE` → `LANG`                     | **`en`** |
| 5   | `normalizeChronosLocale()` + localStorage `chronos/src/lib/ux-vocabulary.ts:16,27` | 明示選択(localStorage)→ `navigator.language`      | catalog  |

- **環境変数が3つ**: `KYBERION_LOCALE`(#1)/ `KYBERION_UI_LOCALE`(#3#4)/ `LANG`(#2#3#4)。加えて音声だけ別系統 `KYBERION_VOICE_LANGUAGE`(`libs/core/python-voice-bridge.ts:128`、既定 `ja`)。
- **既定が `ja` と `en` に割れている**ため、同一プロセス内でも経路によって出力言語が変わりうる。
- `scripts/intent.ts:114,194,395` は `process.env.LANG` を直接読んで #2 に渡しており、**#1 の identity 設定を無視する**。

### 2.3 型のハードコード — 第3言語追加のブロッカー

- `'ja' | 'en'` / `'en' | 'ja'` のリテラル union が **22箇所**(`libs/core/surface-ux.ts:532,551`、`operator-identity.ts:30`、`chronos/src/app/api/agent/route.ts:397` ほか)。
- `ja`/`en` の二択を前提にした**インライン三項ヘルパー**が独自に生えている: `function l(locale: 'en'|'ja', en: string, ja: string)`(`chronos/src/app/api/agent/route.ts:397`、4箇所で使用)。**これがカタログを迂回する6つ目の経路**。
- `libs/core/onboarding-flow-policy.ts` ほか4ファイルに `{ en: '…', ja: '…' }` のインラインマップ。

### 2.4 コード直書き文言 — 止血できていない

非テスト実装ファイルのコード行(コメント除く)に含まれる日本語:

```
合計: 139 ファイル / 1,975 行(コメント内は別途 165 行)
```

| 行数 | ファイル                                                        | 性質                   |
| ---- | --------------------------------------------------------------- | ---------------------- |
| 134  | `satellites/voice-hub/server.ts`                                | 音声 UI 応答           |
| 131  | `libs/core/src/native-pptx-engine/examples/gen_project_plan.ts` | サンプル(対象外候補)   |
| 110  | `libs/core/src/native-xlsx-engine/examples/gen_wbs.ts`          | サンプル(対象外候補)   |
| 107  | `tools/adf-replay-extension/background.js`                      | 拡張(対象外候補)       |
| 63   | `libs/core/surface-mission-steering.ts`                         | **オペレータ面**       |
| 54   | `scripts/virtual_office.ts`                                     | **オペレータ面**       |
| 46   | `libs/core/browser-conversation-session.ts`                     | **オペレータ面**       |
| 44   | `presence/displays/concierge/src/app/page.tsx`                  | **顧客面**             |
| 40   | `scripts/onboarding_wizard.ts`                                  | **オペレータ面**(残余) |
| 34   | `chronos/src/app/page.tsx` / `AgentCollaborationBoard.tsx`      | **オペレータ面**       |
| 32   | `libs/core/surface-runtime-orchestrator.ts`                     | **オペレータ面**       |

ブリッジ4種にも日本語固定応答が残存: `slack-bridge/src/index.ts:195,328,372` / `discord-bridge/src/index.ts:327,339` / `imessage-bridge/src/index.ts:321`。

**enforcement**: `scripts/check_ui_ux_governance.ts` の `status-vocabulary-bypass` ルールは **`scripts/sovereign_dashboard.ts` の `renderStatus(` 出現数が5未満か**を数えるだけ(`:91-101`)。新規のハードコード文言を検知する仕組みは**無い**。

### 2.5 日時・数値の書式 — ロケール非対応かつ非決定的

- `'ja-JP'` / `'en-US'` のロケール文字列直書きが **102箇所**。`libs/core/src/native-pptx-engine/builders.ts` に7箇所など、**成果物(PPTX/XLSX)の書式が日本語固定**。
- 引数なし `toLocaleString()` / `toLocaleTimeString()` が **32箇所**(`chronos/src/components/MissionIntelligence.tsx` に15箇所)。これは**実行環境のロケールに依存**するため、多言語対応以前に [kyberion-development-practices](../../../../knowledge/product/governance/kyberion-development-practices.md) の hermetic テスト方針と衝突する(CI と開発機で出力が変わる)。
- タイムゾーンも同様に暗黙。`pipelines/baseline-check.json` は `Asia/Tokyo` 固定。

### 2.6 LLM 生成応答の言語 — 3方式が並存

| 方式                         | 実装                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| 「ユーザーの言語で返す」指示 | `satellites/slack-bridge/src/index.ts:585`                     |
| 日本語を文言ごと埋め込み     | `libs/core/customer-conversation.ts:127`(`確認して回答します`) |
| 日本語固定のテンプレート応答 | `chronos/src/app/api/agent/route.ts:418,515,668,724,765,811`   |

`structured-output-contracts.ts:109` に `user_language` フィールドが、`surface-runtime-orchestrator.ts:1923,2044` に `Derived language` の導出があるが、**生成側への注入が統一されていない**。

### 2.7 対象外(本計画のスコープ外と明記する領域)

- `pipelines/*.json` の semantic brief 自然文(**40 ファイル**)。これは実行意図の記述であり UI 文言ではない。LLM が読む前提のため翻訳対象としない。
- `docs/` `knowledge/` の文書翻訳 — [DOCUMENTATION_LOCALIZATION_POLICY](../../../DOCUMENTATION_LOCALIZATION_POLICY.md) の管轄。
- `tools/adf-replay-extension` / `tools/meet-copilot-extension`(開発者向け内部ツール、計 181 行)。
- `libs/core/src/native-*-engine/examples/`(サンプルコード、計 241 行)。
- 日本語タイポグラフィ・フォント選択 → DS-03 の管轄。

## 3. ゴール(受入条件)

1. **ロケール解決が1関数**: `@agent/core` の単一実装が全表面(CLI / chronos / concierge / ブリッジ4種 / 音声)で使われ、既定値が1つに定まる。旧5系統は薄いラッパとして deprecate され、`check:*` で新規利用が検知される。
2. **型が閉じていない**: `SupportedLocale` がカタログ由来のデータ駆動型になり、`'ja' | 'en'` のリテラル union が実装コードから消える(22箇所 → 0)。
3. **新規ハードコードが CI で落ちる**: 対象ディレクトリの user-facing 文言リテラルを検知する検査が存在し、既存分を baseline 凍結した ratchet として CI に接続されている。
4. **翻訳漏れが CI で落ちる**: `check:catalogs` が `required_locales` 全てを検査し、未定義キー参照・未使用キーも報告する。
5. **書式が locale/timezone を受け取る**: 日時・数値の整形が core の単一関数経由になり、引数なし `toLocaleString()` が実装コードから消える(32箇所 → 0)。
6. **第3言語がデータ追加だけで通る**: 実際に1言語を追加し、コード変更ゼロで CI・スモークが緑になることを実証する(= 本計画が成功したことの唯一の証拠)。

## 4. 実装項目

| ID      | タイトル                         | 優先度 | 規模 | 依存             |
| ------- | -------------------------------- | ------ | ---- | ---------------- |
| I18N-01 | ロケール解決の単一正本化         | **P0** | M    | なし             |
| I18N-02 | 語彙カタログのメッセージ基盤化   | **P0** | M〜L | I18N-01          |
| I18N-03 | ハードコード禁止の ratchet       | **P0** | M    | I18N-02          |
| I18N-04 | 表面別の文言移行                 | P1     | L    | I18N-02, I18N-03 |
| I18N-05 | 日時・数値書式の国際化           | P1     | M    | I18N-01          |
| I18N-06 | LLM 出力言語の契約化             | P1     | M    | I18N-01          |
| I18N-07 | 第3言語での実証(proof-of-locale) | P2     | S〜M | I18N-01〜05      |
| I18N-08 | 翻訳運用フローと drift 監査      | P2     | M    | I18N-02, I18N-07 |

---

### I18N-01: ロケール解決の単一正本化 — P0 / M

**問題**: 5系統・環境変数3つ・既定値が `ja`/`en` に割れている(§2.2)。

**タスク**

1. `libs/core/locale.ts` を新設し、以下を単一実装として export する。
   - `type SupportedLocale`(I18N-02 でカタログ由来に置換するまでは暫定 union)
   - `resolveLocale(ctx?: { explicit?; surfacePreference?; identityPath? }): SupportedLocale`
   - 優先順位を**1つに固定**: 明示指定(`--locale` / API 引数)→ 表面固有の永続設定(chronos localStorage)→ onboarding identity の `language` → `KYBERION_LOCALE` → OS/ブラウザ(`LANG` / `navigator.language`)→ カタログの `default_locale`
   - **既定値は `default_locale` に一本化**。関数引数の fallback は撤去する(`operator-identity.ts:30` の `= 'ja'` が割れの原因)。
2. 既存5系統を本関数の薄いラッパにし、`@deprecated` を付す。`resolveVocabularyLocale` / `resolveQuestionLocale` / `cli.ts:resolveLocale` は内部呼び出しを本関数へ差し替える。
3. `scripts/intent.ts:114,194,395` の `process.env.LANG` 直読み3箇所を本関数に置換(identity 設定が無視されるバグの解消)。
4. 環境変数を整理: `KYBERION_LOCALE` を正本とし、`KYBERION_UI_LOCALE` は deprecated alias(読むが warn を出す)。`KYBERION_VOICE_LANGUAGE` は「未設定なら `resolveLocale()` に従う」へ変更(現状 `'ja'` 固定既定)。`pnpm generate:env-registry` を再生成する。
5. unit test: 優先順位の全分岐、未知ロケールのフォールバック、env alias の warn。

**受入**: 5系統すべてが同一の解決結果を返すことをテストで固定。`grep -rn "process.env.LANG" libs scripts` の残存が0(意図的な子プロセス env 受け渡し `programmatic-tool-calling.ts:328` を除く)。

---

### I18N-02: 語彙カタログのメッセージ基盤化 — P0 / M〜L

**問題**: 305 キーが `domains.ux` にフラット同居、プレースホルダ規約が未定義(7キーのみアドホック)、整合性検査が default_locale しか見ない(§2.1)。

**タスク**

1. **namespace 分割**: `domains` を `cli` / `chronos` / `concierge` / `bridge` / `onboarding` / `status` / `error` に分割。既存キーの接頭辞(`chronos_*` 143 / `cli_*` 87 ほか)がそのまま対応するため**機械的に移行できる**。旧フラットキーは1リリース間 alias として残す。
2. **プレースホルダ規約の確定**: ICU MessageFormat の**サブセット**(`{name}` の単純補間 + `{count, plural, ...}`)に限定する。ライブラリ導入は行わず、core に最小の formatter を実装する(依存追加を避け、フォーマッタの挙動をテストで固定するため)。**性別・序数・日付書式は ICU に載せず I18N-05 の関数に委ねる**(過剰実装の回避)。
3. **型安全な `t()`**: `t(key, params?, locale?)` を core に単一実装。キーはカタログから生成した union 型(`pnpm generate:*` 儀式で `.d.ts` を生成)にし、**存在しないキーの参照をコンパイル時に落とす**。
4. `SupportedLocale` をカタログの `required_locales` フィールド(新設)から生成し、`'ja' | 'en'` リテラル 22箇所を置換する。`l(locale, en, ja)`(`chronos/api/agent/route.ts:397`)と `{ en, ja }` インラインマップ4ファイルを撤去し `t()` に寄せる。
5. **`check:catalogs` の強化**(`scripts/check_catalog_integrity.ts:197-217`):
   - `required_locales` の**全ロケール**についてキー欠落を検査(現状は default_locale のみ)
   - コード内 `t('…')` 参照とカタログの**双方向突合**(未定義キー参照 / 未使用キー)
   - プレースホルダの**ロケール間一致**検査(en に `{name}` があり ja に無い、を落とす)
6. スキーマ `user-facing-vocabulary.schema.json` に `required_locales` を追加(`additionalProperties: false` のため必須)。

**受入**: 305 キーが namespace 化されても `pnpm check:catalogs` / 既存語彙契約テスト(`tests/chronos-ux-vocabulary-contract.test.ts` ほか3本)が緑。存在しないキーを参照するコードが typecheck で落ちる。

---

### I18N-03: ハードコード禁止の ratchet — P0 / M

**問題**: 新規ハードコードを止める仕組みが無く、現行の `status-vocabulary-bypass` は1ファイルの呼び出し回数を数えるだけ(§2.4)。

**タスク**

1. `scripts/check_i18n_hardcoding.ts` を新設。対象ディレクトリ(`libs/core`, `scripts`, `satellites/*/src`, `presence/displays/*/src`)の TS/TSX を走査し、**user-facing に到達しうる文字列リテラル**を検知する。
   - 検知対象: 日本語文字を含むリテラル / 既知の出力関数(`console.log`, `process.stdout.write`, JSX テキストノード, `reply(`, `sendText(`)への文字列直渡し
   - 除外: import パス、ログの技術文言(`[PREFIX]` 付き)、テスト、§2.7 の対象外領域
2. **baseline 凍結方式**(既存 `tests/*-baseline.test.ts` の慣行に合わせる): 現行の違反箇所を `knowledge/product/governance/i18n-baseline.json` に凍結し、**新規追加のみ fail**。移行が進むたび baseline を縮める(増加は不可 = ratchet)。
3. `pnpm check:i18n` を追加し、`validate` と CI(`pr-validation.yml`)に接続する。
4. baseline の初期値は §2.4 の実測から生成(139 ファイル / 1,975 行が出発点)。

**受入**: 新しくハードコード日本語を追加した PR が CI で落ちる。baseline を増やす変更が検知される。

---

### I18N-04: 表面別の文言移行 — P1 / L

**方針**: 一括翻訳はしない。**オペレータ/顧客が日常的に見る面から順に**、1面 = 1コミットで移行する。各コミットで `pnpm lint && pnpm typecheck && pnpm test:unit` を通す。

| 順  | 対象                                                                                                                                                                                        | 規模の目安       | 理由                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------- |
| 1   | ブリッジ4種(slack/discord/telegram/imessage)                                                                                                                                                | 6箇所 + 定型応答 | **外部の人間が見る面**。影響が最も外向き |
| 2   | concierge(`page.tsx` 44行 + `setup/page.tsx` 16行)                                                                                                                                          | 60行             | **顧客面**。i18n ゼロ                    |
| 3   | chronos 残余(`page.tsx` / `AgentCollaborationBoard` / `api/agent/route.ts`)                                                                                                                 | 88行             | 主要オペレータ面。`l()` 撤去を含む       |
| 4   | `libs/core` オペレータ文言(`surface-mission-steering` 63 / `surface-runtime-orchestrator` 32 / `surface-runtime-helpers` 26 / `surface-approval-ui` 26 / `browser-conversation-session` 46) | 193行            | 複数表面が共有する文言                   |
| 5   | `scripts`(`virtual_office` 54 / `onboarding_wizard` 40 / `kyberion_home` 39)                                                                                                                | 133行            | CLI 面                                   |
| 6   | `satellites/voice-hub/server.ts`                                                                                                                                                            | 134行            | 音声。TTS ロケールと連動(I18N-05 依存)   |
| 7   | operator-surface / presence-studio / computer-surface                                                                                                                                       | 少量             | UX-03 で「対象外」と記録済。ここで解禁   |

**共通ルール**: **キー化しても既定ロケールでは従来と同一文字列**を出す。これによりスナップショット/文字列マッチの既存テストが壊れない(UX-03 で有効だった原則を踏襲)。

**対象範囲の正本**: 移行対象は推測ではなく **I18N-03 の baseline が正確に列挙している** — `knowledge/product/governance/i18n-baseline.json`(2026-07-26 時点で 100 ファイル / 1,056 件)。移行が進むたび `--update-baseline` で締め直すため、**baseline の残件数がそのまま I18N-04 の進捗**になる。

**I18N-05 からの繰り越し(順3 chronos に含める)**: chronos の `'use client'` 群は `libs/core/format.ts` が module scope で secure-io を引くためブラウザバンドルに載せられず、解決済みロケールを `toLocaleString` に明示引数として渡す形に留めてある(環境依存という本質的な問題は解消済み)。**`locale-normalize.ts` と同型に `format.ts` の純粋 Intl 部分を import ゼロのモジュールへ分離**すれば共有 formatter に載る。chronos を触る順3 で同時に行うこと(単独で先行実装しても消費者がいない)。

---

### I18N-05: 日時・数値書式の国際化 — P1 / M

**問題**: `'ja-JP'`/`'en-US'` 直書き 102箇所、引数なし `toLocaleString()` 32箇所(§2.5)。後者は多言語以前に**非決定的**。

**タスク**

1. `libs/core/format.ts` に集約: `formatDateTime(value, { locale, timeZone, style })` / `formatNumber` / `formatCurrency` / `formatRelativeTime`。locale・timeZone は**必須引数**とし、暗黙の環境依存を型で禁止する。
2. timeZone の解決を `resolveLocale()` と同じ経路に載せる(identity → `KYBERION_TIMEZONE` → 既定 `Asia/Tokyo`)。テストでは固定注入する。
3. 引数なし `toLocaleString()` 32箇所を置換(最大は `chronos/src/components/MissionIntelligence.tsx` の15箇所)。
4. `'ja-JP'` 直書き 102箇所を置換。**成果物系を優先**: `native-pptx-engine/builders.ts`(7箇所)、`native-xlsx-engine/drawing.ts`(3箇所)は生成ドキュメントの書式に直結する。
5. hermetic テスト: 固定 timeZone・固定 locale で golden を作り、CI と開発機で同一出力になることを確認する。

**受入**: `grep -rn "toLocaleString()" libs scripts presence satellites`(実装コード)が0件。PPTX/XLSX の日付書式が locale 引数で切り替わることをテストで固定。

---

### I18N-06: LLM 出力言語の契約化 — P1 / M

**問題**: 生成応答の言語制御が3方式併存(§2.6)。日本語を文言ごと埋め込んだプロンプトすらある。

**タスク**

1. 「**生成文の言語 = 解決済み operator locale**」を単一のプロンプト断片(`libs/core/working-principles.ts` 経由の worker prompt 注入と同じ経路)として実装する。`slack-bridge:585` の方式を正本に採用。
2. `libs/core/customer-conversation.ts:127` の日本語埋め込み(`確認して回答します`)を撤去し、**マーカーは言語非依存**(`ESCALATION_MARKER`)に、文言はロケール解決に委ねる。
3. `chronos/src/app/api/agent/route.ts` の日本語固定テンプレート応答6箇所(`:418,515,668,724,765,811`)を I18N-02 の `t()` へ移行(I18N-04 順3 と同一コミットで可)。
4. `structured-output-contracts.ts:109` の `user_language` と `surface-runtime-orchestrator.ts:1923,2044` の `Derived language` 導出を `resolveLocale()` の結果と突合し、**乖離したら warn** を出す(ユーザーが英語で書いたのに identity が ja、等の検知)。
5. 音声: STT/TTS の言語(`python-voice-bridge.ts:128`、`in-room-minutes-recorder.ts:139`、`speech-to-text-bridge.ts`)を同じ解決結果に接続する。

**受入**: 日本語文言を含む prompt 文字列が実装コードから消える。ロケール別に生成応答の言語が変わることを非 stub backend でスモーク確認。

---

### I18N-07: 第3言語での実証(proof-of-locale)— P2 / S〜M

**目的**: 「i18n されたと言えるか」の**唯一の客観的証拠**。翻訳品質ではなく**経路の実証**が目的。

**タスク**

1. `required_locales` に第3言語を1つ追加する。**推奨は疑似ロケール `qps-ploc`**(全文字を装飾した機械生成)。理由: 人手翻訳コストゼロで、**未翻訳箇所が目視で即座に判る**(装飾されていない文字列 = ハードコード残存)。実言語を選ぶ場合は `ko` または `zh-Hans`。
2. 疑似ロケールのカタログを**生成スクリプト**で作る(`scripts/generate_pseudo_locale.ts`。en から機械変換、プレースホルダは保存)。手管理しない。
3. CI に第3ロケールでのスモークを追加: CLI help / chronos SSR / ブリッジ応答が**コード変更ゼロで**第3言語になることを確認。
4. 実施して初めて判る漏れ(型の閉じ、fallback 経路、書式)を I18N-01〜05 にフィードバックする。**この項目で赤が出たら前段が未完である**、と扱う。

**受入**: 第3言語の追加差分が **カタログ JSON + `required_locales` の1行のみ**(実装コードの変更ゼロ)。

---

### I18N-08: 翻訳運用フローと drift 監査 — P2 / M

**タスク**

1. **新規キーの追加儀式**を [kyberion-development-practices](../../../../knowledge/product/governance/kyberion-development-practices.md) に登録: カタログ追加 → `check:catalogs` → 未翻訳ロケールは `default_locale` フォールバック + 1回だけ warn(既存 `[UX_VOCAB]` warn の方式を踏襲、`ux-vocabulary.ts:119-123`)。
2. **翻訳漏れレポート**: ロケール別のカバレッジ率(キー数比)を出力するスクリプトを追加。
3. **週次 drift 監査 pipeline** を `pipelines/i18n-drift-audit.json` として追加(既存 `pipelines/ui-ux-governance-audit.json` に倣う)。監査項目: baseline 増加 / 翻訳カバレッジ低下 / 未使用キー蓄積。
4. `docs/DOCUMENTATION_LOCALIZATION_POLICY.md` の「Vocabulary Rule」節を本計画の成果(namespace 構成・`t()` 規約・ratchet)に合わせて更新する。

---

## 5. 推奨実施順序

```
Wave 1 (基盤・並行不可): I18N-01 → I18N-02 → I18N-03
                          ※ この3つが揃うまで I18N-04 の移行は始めない
                            (移行先の API が定まらないと二度手間になる)
Wave 2 (並行可):          I18N-05, I18N-06, I18N-04 順1〜3(ブリッジ/concierge/chronos)
Wave 3:                   I18N-04 順4〜7(libs/core・scripts・voice-hub・残表面)
Wave 4 (検証と定着):      I18N-07 → 前段へのフィードバック → I18N-08
```

**I18N-07 を最後に置くが、前倒しの価値がある**: Wave 2 の途中で疑似ロケールを一度回すと、型の閉じや fallback の穴が早期に露出する。Wave 2 完了時点で1度予行することを推奨する。

## 6. リスクと注意

- **テスト破壊**: 文言変更はスナップショット/文字列マッチテストを壊す。**「キー化するが既定ロケールの出力文字列は不変」**を原則とし、テスト修正は文言そのものを変えた箇所に限定する(UX-03 で有効だった方針)。
- **`domains.ux` 分割の影響範囲**: 305 キーを参照する箇所が CLI・chronos・core に散在する。**旧フラットキーの alias を1リリース残す**ことで大規模同時変更を避ける。
- **過剰な i18n ライブラリ導入**: `i18next` 等の導入は依存とビルド構成を増やし、secure-io 経由のカタログ読み込み(`ux-vocabulary.ts:89`)と衝突する。**core に最小 formatter を実装する方針を維持**する。
- **ratchet の誤検知**: I18N-03 の検知はヒューリスティックであり、ログの技術文言等を誤検知しうる。**baseline 凍結 + 除外リスト**で運用し、誤検知が多い場合は検知条件を絞る(緩めても「新規のみ fail」の性質は保てる)。
- **RTL・複数形の深追い**: アラビア語等の RTL、スラブ系の複数形カテゴリは本計画のスコープ外。`required_locales` に該当言語を足す段階で別計画とする。
- **日本語タイポグラフィ**: 生成ドキュメントのフォント/禁則は DS-03 の管轄。本計画は**文言と書式のみ**を扱う。

## 7. 作業規約(全項目共通)

1. ファイル I/O は必ず `@agent/core/secure-io` 経由([AGENTS.md](../../../../AGENTS.md) §1)。
2. 変更前に対象ファイルを必ず読み、本計画記載の行番号が現状とずれていれば**現状を正**とする(行番号は 2026-07-26 時点の実測)。
3. テストを先に緑で確認 → 変更 → 同テストが緑のままであることを確認。
4. 1項目 = 1ブランチ、項目内もタスク単位でコミットを分け、各コミットで `pnpm lint && pnpm typecheck && pnpm test:unit` を通す。
5. 一時ファイルは `active/shared/tmp/` のみ使用。
