# IP-11: 型安全性ラチェット(strict 化・any 削減)

> 優先度: P2 / 規模: L(継続的ラチェット) / 依存: IP-03(CI ゲートが先)

## 背景と課題

- `tsconfig.json:8-9` が `"strict": false`, `"noImplicitAny": false`。strict 系フラグはゼロ。
- `eslint.config.js:85-92` が `@typescript-eslint/no-explicit-any` を含む型安全系ルールを全て off。
- 結果、ソース全体で `: any` **1,727** + `as any` **1,175**(約2,900箇所)。ホットスポットは `media-actuator`(index.ts 123、test 94、helpers 46+40 で最悪クラスタ)、`libs/core/agent-adapter.ts`(32)、`satellites/voice-hub/server.ts`(34)。`@ts-ignore` が 6 箇所(`libs/core/acp-mediator.ts:128`、`agent-adapter.ts:299,317,406`、`media-actuator/src/artisan/extraction-engine.ts:7,163`)。
- ADF・intent contract・推論結果という「構造で正しさを担保する」設計の中核が、境界の `any` で無効化されている。

## 方針

一括 strict 化は現実的でない(数千エラー)。**「新規悪化を止める → ホットスポットを潰す → フラグを一つずつ上げる」のラチェット方式**を取る。

## ゴール(受入条件)

1. any 使用数のベースラインが記録され、**増加すると CI が fail する**ラチェットが動く。
2. `noImplicitThis` / `strictBindCallApply` / `alwaysStrict` / `useUnknownInCatchVariables` のうち、エラー件数が少ないフラグから有効化される(最低 2 つ)。
3. `@ts-ignore` 6 箇所が解消(型修正)または `@ts-expect-error` + 理由コメントに置換される。
4. `media-actuator` の非テストコードの any が半減する。

## 実装タスク

### Task 1: ラチェット基盤 — `claude-sonnet-4`

1. `scripts/check_type_ratchet.ts` を新設: `grep -c` ではなく TypeScript AST(既に devDependencies にある typescript の API)で `: any` / `as any` / `@ts-ignore` をディレクトリ別に集計し、`knowledge/product/orchestration/type-ratchet-baseline.json`(要検討: 置き場所は既存の check 系ベースラインの慣例に合わせる)と比較して増加時に exit 1。
2. 初回実行でベースラインを生成し、`pnpm check:type-ratchet` として `validate` チェーンと CI に追加(IP-03 のワークフロー変更に相乗り)。
3. ベースライン更新は「減った時に自動更新 or 手動コマンド」のどちらかに設計し、README に運用を1段落書く。

### Task 2: strict 系フラグの段階有効化 — `claude-sonnet-4`

1. `tsc --noEmit` を以下のフラグを 1 つずつ足して実行し、エラー件数を計測して表にする: `alwaysStrict`, `strictBindCallApply`, `noImplicitThis`, `useUnknownInCatchVariables`, `strictFunctionTypes`, `noFallthroughCasesInSwitch`。
2. エラー 0〜30 件のフラグは即修正して有効化。30 件超のフラグは件数を記録して本文書末尾に「次の候補」として残す。
3. `tsconfig.actuators.json` は root を extends しているため自動追従することを確認。

### Task 3: `@ts-ignore` の解消 — `claude-sonnet-4`

- 6 箇所それぞれについて、抑制している実際の型エラーを確認し、(a) 型定義修正で解消、(b) 不可能なら `@ts-expect-error` + 1 行理由、に置換。`eslint` の `ban-ts-comment` を `@ts-ignore` のみ error に設定して再発防止。

### Task 4: media-actuator の any 削減 — `claude-sonnet-4`(大きいので 2〜3 バッチに分割)

1. `libs/actuators/media-actuator/src/` の非テスト any(index.ts 123、helpers 86)を対象に、まず入出力境界(action payload、パイプラインステップの結果)へ型を定義する。`manifest.json` の action 定義と `schemas/` を型の出発点にする。
2. 内部伝播の any は境界型が決まれば連鎖的に消えるため、境界 → 内部の順で進める。1 バッチごとに `pnpm typecheck` と media-actuator のテスト 5 本を実行。
3. テストコード内の any(94+134)は優先度最低。触らなくてよい。

### Task 5: agent-adapter / voice-hub の境界型付け — `claude-sonnet-4`

- `libs/core/agent-adapter.ts`(as any 32・@ts-ignore 3)は外部エージェント連携の境界。外部レスポンスは `unknown` で受けて型ガードで絞る形へ書き換える。voice-hub は IP-10 フェーズ2(分割)の後に実施する方が安全なので、分割前なら**スキップして報告**。

## リスクと注意

- `any` の除去は「型が合わないことが露見して実バグが見つかる」ことがある。**型の都合でランタイム挙動を変えない**こと。挙動修正が必要に見えたら分けて報告する。
- ラチェットの集計は test ファイルを分けてカウントする(テストの any は許容度が高い)。ベースライン JSON にカテゴリ別集計(src / test)を持たせる。

## 実装メモ

- `scripts/check_type_ratchet.ts` を追加し、baseline を `scripts/check_type_ratchet.baseline.json` に置いた。fixture ベースの unit test も追加し、`check:type-ratchet` を `validate` チェーンへ接続した。
