# IP-02: native-\*-engine 等の secure-io 不変条件違反の解消

> 優先度: **P0** / 規模: M / 依存: IP-01(lint 実効化) / 関連: IP-08

## 背景と課題

AGENTS.md §1 は「ファイル I/O は `@agent/core/secure-io` 経由のみ」と定めるが、`libs/core` 自身の内部に raw `fs` import が残っており、tier-guard・policy-engine(`validateWritePermission` 等)を素通りして読み書きしている。ドキュメントエンジンは成果物ファイルを直接書き出すため、データ tier 漏洩防止の観点で最も影響が大きい。

### 対象ファイル(2026-07-02 時点)

**libs/core 内(最優先):**

| ファイル                                                      | 違反箇所                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `libs/core/src/native-pdf-engine/engine.ts`                   | `:17` import、読み `:250`,`:508`、**書き `:1344` (`fs.writeFileSync`)** |
| `libs/core/src/native-docx-engine/engine.ts`                  | `:7` import、`:681`                                                     |
| `libs/core/src/native-pptx-engine/engine.ts`                  | `:2` import、`:334`,`:402`(画像読み込み+zip)                            |
| `libs/core/src/native-xlsx-engine/engine.ts`                  | `:7` import                                                             |
| `libs/core/mlx-embedding-backend.ts`                          | `:15` import                                                            |
| `libs/core/src/native-docx-engine/examples/roundtrip_docx.ts` | `:8`(example スクリプト)                                                |

**scripts 内(次点):**

| ファイル                                 | 違反箇所 |
| ---------------------------------------- | -------- |
| `scripts/dependency_resolver.ts`         | `:25`    |
| `scripts/chronos_daemon.ts`              | `:11`    |
| `scripts/scenario_storage_governance.ts` | `:14`    |
| `scripts/verify-design-resolution.mjs`   | `:6`     |

(`scripts/ts-loader.mjs` はブートストラップのため IP-01 で allowlist 済み。)

## ゴール(受入条件)

1. 上記全ファイルから raw `fs` import が消え、`@agent/core/secure-io`(`safeReadFile`/`safeWriteFile` 等)または、secure-io が依存できない基盤層に限り `@agent/core/fs-primitives` を経由する。
2. IP-01 の Task 2 で付与した暫定 `eslint-disable` コメントが全て除去され、`pnpm lint` が素で通る。
3. 各エンジンの既存テスト(`libs/core/src/native-*-engine/__tests__/`)が全て緑のまま。
4. `tests/foundation-io-boundary.test.ts`・`tests/core-fs-exception-boundary.test.ts` が緑(ローカル実行で確認。CI 組み込みは IP-03)。

## 実装タスク

### Task 1: secure-io API の適合性確認 — `claude-sonnet-4`

1. `libs/core/secure-io.ts` を読み、エンジンが必要とする操作(バイナリ Buffer の同期読み込み、バイナリ書き出し、存在確認、ディレクトリ作成)に対応する公開 API を一覧化する。
2. 不足がある場合(例: 同期バイナリ読み取りが無い)は、**新規の raw fs 呼び出しを増やすのではなく** `fs-primitives.ts` に薄いプリミティブを追加し、secure-io から公開する。追加 API には unit test を付ける。
3. 結果を本文書の末尾に「API マッピング表」として追記する(後続タスクの参照用)。

### Task 2: native-pdf-engine の移行(パターン確立)— `claude-sonnet-4`

1. まず `libs/core/src/native-pdf-engine/__tests__/` の既存テストを実行し緑を確認する。
2. `engine.ts` の import を差し替え、`:250`,`:508` の読み込みと `:1344` の `writeFileSync` を Task 1 で確認した API に置換する。エラーハンドリングは既存挙動を維持(例外型が変わる場合はテストで吸収)。
3. テスト再実行 → 緑。`eslint-disable` コメント除去 → `pnpm lint` 通過。
4. 変更 diff を「移行パターン」として記録する(Task 3 の指示に含めるため)。

### Task 3: docx / pptx / xlsx エンジン + example の横展開 — `claude-haiku`(Task 2 の diff をパターンとして添付すること)

- Task 2 と同一パターンで `native-docx-engine/engine.ts`, `native-pptx-engine/engine.ts`, `native-xlsx-engine/engine.ts`, `examples/roundtrip_docx.ts` を移行する。1ファイルごとに該当 `__tests__` を実行して緑を確認する。パターンから外れる箇所(zip ストリーム等)に遭遇したら**自分で判断せず** sonnet 担当へエスカレーションする。

### Task 4: mlx-embedding-backend と scripts 4本の移行 — `claude-sonnet-4`

1. `libs/core/mlx-embedding-backend.ts:15` を secure-io 経由に置換。埋め込みモデルのファイル存在確認・読み込みが対象。
2. `scripts/dependency_resolver.ts`, `scripts/chronos_daemon.ts`, `scripts/scenario_storage_governance.ts`, `scripts/verify-design-resolution.mjs` を同様に移行。scripts は `@agent/core` を import できる(既存の他 scripts が前例)。`.mjs` ファイルはコンパイル経路が異なるため、`node scripts/verify-design-resolution.mjs` の手動実行で動作確認する。
3. 各スクリプトに対応するテストがあれば実行、なければ最低限「ヘルプ表示 or dry-run 実行」で起動確認する。

### Task 5: 境界テストによる最終検証 — `claude-sonnet-4`

1. `vitest run tests/foundation-io-boundary.test.ts tests/core-fs-exception-boundary.test.ts` を実行し緑を確認。
2. `grep -rn "from 'node:fs'\|from 'fs'" libs/core scripts --include='*.ts' --include='*.mjs'` の残存ヒットが allowlist(secure-io.ts, fs-primitives.ts, ts-loader.mjs, \*.test.ts)のみであることを確認し、結果を PR/パッチ説明に添付する。

## リスクと注意

- secure-io 経由にすると tier-guard の書き込み検証が効き始めるため、**これまで書けていたパスへの書き込みがブロックされる可能性がある**。テストが `[POLICY_BLOCKED]` で落ちた場合は、パスが正当(`active/shared/tmp/` 等)なら policy 設定を確認し、不正なパスへの書き込みだったならそれ自体が今回直すべきバグなので報告する。
- example スクリプト(`roundtrip_docx.ts`)には `/Users/...` ハードコードもある(IP-14 対象)。この IP では fs 置換のみ行い、パス修正は IP-14 に委ねる。

## API マッピング表

| 需要                        | 採用 API                                          | 備考                                                               |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| テキスト / バイナリ読込     | `safeReadFile(..., { encoding: 'utf8' \| null })` | 画像・JSON・README などを統一。`encoding: null` で Buffer を返す。 |
| 安全な書き込み              | `safeWriteFile()`                                 | PDF 生成の最終書き出しに使用。atomic write と policy gate を維持。 |
| 存在確認                    | `safeExistsSync()`                                | 例外ではなく明示分岐が必要な箇所に使用。                           |
| ディレクトリ作成            | `safeMkdir()`                                     | 出力先の親ディレクトリ生成に使用。                                 |
| 再帰列挙 / ディレクトリ判定 | `safeReaddir()` + `safeLstat()`                   | `chronos_daemon` のパイプライン列挙に使用。                        |
| 基盤層の raw バイナリ I/O   | `rawReadBuffer()` / `rawWriteFile()`              | `fs-primitives.ts` の基盤限定 API。feature code では使わない。     |

## 検証メモ (2026-07-03)

- `pnpm lint`
- `pnpm run typecheck`
- `pnpm exec vitest run tests/foundation-io-boundary.test.ts tests/core-fs-exception-boundary.test.ts`
- `node scripts/verify-design-resolution.mjs` は fixture 欠落時に skip 表示で dry-run 完了
