# IP-01: ESLint ガバナンスの実効化(secure-io 不変条件の lint 復活)

> 優先度: **P0** / 規模: S / 依存: なし / 後続: IP-02(このIPで顕在化する違反の修正)

## 背景と課題

AGENTS.md §1 の不変条件「ファイル I/O は `@agent/core/secure-io` 経由のみ。`node:fs` を直接呼ばない」は `eslint.config.js` の `no-restricted-imports` で強制する設計になっているが、**実際にはほぼ無効化されている**。

- `eslint.config.js:7-25` のグローバル `ignores` ブロックが `tests/**`, `scripts/**`, `tools/**`, `libs/core/*.ts` を丸ごと除外している。ESLint では ignore が個別設定に勝つため:
  - `eslint.config.js:110-141` に定義された `scripts/**`・`tests/**`・`libs/shared-*` 向けの fs/child_process 禁止ルールは **一度も評価されない死んだルール** になっている。
  - 不変条件の本丸である `libs/core/*.ts`(secure-io 自身が住む場所)は **一切 lint されていない**。
- 現に `libs/core` 内に raw `fs` import が 6 ファイル存在する(詳細は IP-02)。
- ライブ強制が残っているのは `libs/actuators/**`, `satellites/**`, `presence/**`, `libs/shared-*` のみ。

## ゴール(受入条件)

1. `scripts/**`, `tests/**`, `libs/core/**` が ESLint の対象に戻り、fs/child_process 禁止ルールが実際に評価される。
2. 正当な例外(`libs/core/secure-io.ts`, `libs/core/fs-primitives.ts`, `scripts/ts-loader.mjs`, テストのセットアップ用途)は明示的な allowlist で許可される。
3. `pnpm lint` が `--max-warnings 0` のまま通る(既存違反は IP-02 で解消するまで、ファイル単位の明示的 disable + 追跡コメントで管理)。
4. 検証: `scripts/` 配下の任意ファイルに `import fs from 'node:fs'` を仮追加すると lint が失敗すること。

## 実装タスク

## 実装状況 (2026-07-03)

- **完了**: `eslint.config.js` の global ignore は `scripts/**` / `tests/**` / `libs/core/**/*.ts` を除外しない形になっており、`libs/core/**/*.ts` に `fs` / `node:fs` / `child_process` / `node:child_process` の禁止を適用した。`secure-io.ts` と `fs-primitives.ts` は allowlist。
- **完了**: 既存の `libs/core` raw `child_process` 利用 29 ファイルに、IP-08 または foundation wrapper としての追跡付き `eslint-disable no-restricted-imports` を付与した。挙動変更はしていない。
- **完了**: `scripts/ts-loader.mjs` と test ファイル群の例外は維持し、既存テストセットアップを壊さない段階導入にした。
- **検証済み**: `pnpm lint`、`pnpm run typecheck`、`git diff --check`。
- **検証済み**: `scripts/intent_smoke.ts` と `libs/core/config-loader.ts` に仮で `import * as fs from 'node:fs'` を追加した場合、`pnpm lint` が両方を `no-restricted-imports` で失敗させることを確認し、仮差分は除去済み。

### Task 1: ignores の縮小とルールスコープの再設計 — `claude-sonnet-4`

1. `eslint.config.js` を読み、グローバル `ignores`(7-25行付近)から `tests/**`, `scripts/**`, `libs/core/*.ts` を除去する。`tools/**` は中身がブラウザ拡張・静的アセットのため ignore 維持でよい。`dist/**`, `node_modules/**`, `.next/**`, `retired/**`, `coverage/**` などビルド成果物の ignore は維持する。
2. `libs/core/**/*.ts` を対象とする `no-restricted-imports`(`fs`, `node:fs`, `child_process`, `node:child_process` 禁止、メッセージに AGENTS.md §1 を引用)ブロックを新設する。
3. 同ブロックの直後に、allowlist 用の設定を追加: `files: ['libs/core/secure-io.ts', 'libs/core/fs-primitives.ts']` に対して当該ルールを `off`。
4. `scripts/**` 用の既存ルール(110-141行)に `scripts/ts-loader.mjs` の例外を追加(ローダー自体は TS コンパイル前に fs が必要なブートストラップ)。
5. `tests/**` は fs 直 import がテストセットアップで約40ファイル使われている実態があるため、`tests/**` と `**/*.test.ts` に限り fs 禁止を `warn` に落とすか例外化する(既存テストを壊さないこと優先。`child_process` 禁止は維持)。

### Task 2: 既存違反の棚卸しと暫定 disable 付与 — `claude-sonnet-4`

1. `pnpm lint` を実行し、Task 1 で顕在化した違反を全件リスト化する。
2. 各違反ファイルの先頭に `/* eslint-disable no-restricted-imports -- IP-02 で secure-io へ移行予定 (docs/developer/improvement-plans-2026-07/IP-02_NATIVE_ENGINE_SECURE_IO.ja.md) */` を付与する。**コードの挙動は一切変えない**。
3. 顕在化した違反一覧を IP-02 の文書の「対象ファイル」節と突き合わせ、IP-02 に載っていないファイルがあれば IP-02 文書に追記する。

### Task 3: 検証とレグレッション確認 — `claude-haiku`

1. `pnpm lint` が exit 0 で通ることを確認。
2. `scripts/` 配下の任意の `.ts` に `import * as fs from 'node:fs'` を一時追加 → `pnpm lint` が失敗することを確認 → 元に戻す。同様に `libs/core/` でも確認。
3. `pnpm typecheck` と `pnpm test:core` が変更前と同じ結果であることを確認(この IP はコード挙動を変えないため)。

## リスクと注意

- `scripts/**` を lint 対象に戻すと、fs 以外のルール(構文系)でも新規警告が出る可能性がある。その場合は fs/child_process 禁止だけを狙い撃ちで有効化し、他ルールは `scripts/**` に対して現状維持(off)とする段階導入でよい。
- `eslint.config.js` の flat config は順序依存。allowlist ブロックは禁止ブロックより**後ろ**に置くこと。
