---
title: kyberion read の URL 直接読み取り対応計画
kind: plan
status: draft
last_updated: 2026-11-25
tags: [plan, cli, read, network-fetch, egress, perception, url]
importance: 7
---

# kyberion read の URL 直接読み取り対応計画

`pnpm kyberion read <url>` を実現し、現在手順化されている「network:fetch で取得 → tmp に保存 → read で読む」という回り道を、知覚動詞 `read` に組み込む計画です。

## 背景と現状（2026-11-25 の調査）

- `scripts/cli/cli-read.ts` は `URL_PATTERN` に一致する入力を `INVALID_INPUT` で拒否し、「network:fetch op で取得 → `active/shared/tmp/` に保存 → read する」よう誘導する。拒否を固定するテストが `scripts/cli/cli-read.test.ts`（`refuses URLs with a pointer to the governed fetch path`）と `scripts/cli/cli-error-contract.test.ts:203`（`next_action` に `network:fetch` を含む）にある。
- `capability-verb-inventory.md` §3 は URL / web ページを「まだ動詞でない」として記録し、未決事項を「egress ゲートをどこで評価するか」としていた。当時は egress 判定を知覚動詞の内側に入れる設計が未解決だった。
- **今は egress ガバナンスが成熟している**。`secureFetch`（`libs/core/network.ts`）が `assertNetworkEgress` → `evaluateEgressPolicy`（deny / warn / allow）+ 監査チェーン記録を内蔵し、network-actuator の `fetch` op は `runExternalOperation`（`operationId: 'network:fetch_read'`、`requiresApproval: false` for GET/HEAD）で admission を通している。
- **ドッグフーディングで実証済み**（2026-11-25）：scratch pipeline で `network:fetch` → `system:write_file` → `kyberion read` を実行し、`https://sre-magazine.net/articles/7/aoto/` を全文取得できた（非許可リストホストは warn のみで許可、監査に記録）。
- `readDocument`（`libs/core/media/document-reader.ts`）は `source: string | Buffer` を受け付ける。**fetch 結果を Buffer のまま渡せば tmp ファイル保存すら不要**。
- パイプライン経路の注意点：ADF ctx 上の fetch 結果は `libs/core/workforce/output-artifacts.ts` により `{artifact_path, preview, truncated}` envelope に蒸留される（大きい本文は ctx 上ではプレビューのみ）。全文取得には artifact_path のログを読む必要がある。CLI 側で `secureFetch` を直接呼べばこの制限を回避できる。

## 決定事項（ユーザー確認済み 2026-11-25）

- **承認セマンティクス**：`network:fetch_read` と同等。GET のみ・承認不要。egress-policy の deny / warn / allow と監査チェーン記録はそのまま継承。非許可リストホストは warn + 監査記録で許可（現行動作と一貫）。
- **パイプライン側の範囲**：今回は CLI のみ。ADF 内の URL → digest 経路（`network:fetch` → `write_file` → `media:document_digest` の3ステップ、または op 拡張）は別計画とする。

## 設計

### 方針

`cli-read.ts` に URL 分岐を追加し、fetch → Buffer → `readDocument` を in-process で行う。egress 判定は `secureFetch` / `runExternalOperation` の既存境界に留め、動詞自身は引数解析と repo 境界チェックだけを持つ（`draw` / `capture` の前例と同じ分担）。network-actuator の op 経由にしない理由は、ctx 蒸留で本文が切り詰められるため（上記）。ガバナンスは op ではなく `runExternalOperation` + `assertNetworkEgress` の層を共有する。

### 実装ステップ

#### R1 — `scripts/cli/cli-read.ts` の URL 対応

1. `URL_PATTERN` 一致時の拒否を、URL 読み取り分岐に置き換える。
   - スキームは `http:` / `https:` のみ許可（`file:`・`javascript:` 等は拒否）。`validateUrl` の SSRF / ローカルネットワーク既定拒否に乗る。v1 に `--allow-local-network` フラグは付けない。
   - `runExternalOperation({ operationId: 'network:fetch_read', effect: { params: { url, method: 'GET' } }, requiresApproval: false, delegable: false, observationOnly: true }, () => secureFetch({ url, method: 'GET', responseType: 'arraybuffer', timeout }))` で取得。監査・egress warn/deny・retry は network:fetch GET と同一経路。
2. **フォーマット推定**（`inferUrlDocumentFormat`、新規の小さな純粋関数 — `cli-read.ts` または `libs/core/media/document-reader.ts` 近辺）：
   - まず URL パスの拡張子を `READABLE_DOCUMENT_EXTENSIONS` に引く（`.pdf`、`.md`、`.html`、`.json` 等）。
   - 拡張子なし・不明なら magic bytes で推定：`%PDF` → pdf、`PK\x03\x04` → URL 拡張子で docx/pptx/xlsx を選べなければ「オフィス文書と判定、拡張子を添えて保存し直すか --out で指定」と actionable エラー、先頭 `<` → html、それ以外 → text。
   - Content-Type ヘッダは `secureFetch` が `response.data` のみ返すため v1 では使わない（R3 の任意拡張）。
3. `readDocument(buffer, format, options)` を呼び、既存の `renderReadResult` で出力。`--json` / `--out` / `--ocr` / `--tier` / `--tenant` / `--training-use` / `--images` は全てそのまま適用（`--images` の出力先は repo 内必須の既存チェックを再利用）。
4. エラー分類（§3.2 error contract に合わせる）：
   - 非 http(s) スキーム → `INVALID_INPUT`。
   - `SecureFetchError`：`httpStatus` 404 → `NOT_FOUND`、403/401 → `permission_denied` 相当、他は新規 `FETCH_FAILED`（category: `network`、retryable: 5xx/timeout は true）。
   - egress deny（`[NETWORK_POLICY_VIOLATION]`）→ `permission_denied` で透過。
   - 形式が推定不能なオフィス zip → `INVALID_INPUT` + 保存して明示拡張子で read し直す手順を `next_action` に。
5. `READ_USAGE` とファイル先頭コメントを更新（URL 入力可・GET のみ・egress ガバナンスの一文）。`kyberion --help` の `read` 説明（`knowledge/product/governance/cli-commands.json` の `cli_cmd_operator_cli_read` キーに対応するロケールカタログ）も更新。

#### R2 — テスト

- `cli-read.test.ts`：URL 拒否テストを URL 読み取りテストに置き換える。fetch 境界は `runReadCommand` に injectable な fetch 実装（省略時 `secureFetch`）を渡せる形にして hermetic にする。ケース：
  - `https://example.com/page`（html バイト）→ Markdown 出力。
  - 拡張子なし URL で `%PDF` バイト → pdf として読める（小さい PDF fixture または magic のみのモックで分岐確認）。
  - `file:///etc/passwd` → `INVALID_INPUT` で拒否。
  - fetch が `SecureFetchError(404)` → `NOT_FOUND`。
  - egress deny エラー文字列が透過される。
- `cli-error-contract.test.ts:203`：URL 入力は `network:fetch` 誘導ではなくなるので、当該 assertion を新しい分岐の error contract（`FETCH_FAILED` 等）に更新。
- `validateUrl` の SSRF / ローカルネットワーク拒否は既存テストで担保（新規不要、呼び出し経路のみ確認）。

#### R3 —（任意フォローアップ）`secureFetch` のフルレスポンス

Content-Type ヘッダでフォーマットを確定的に判定したい場合、`SecureFetchOptions` に `kyberion_full_response?: boolean`（返り `{data, headers, status}`）を additive に追加する選択肢をメモとして残す。v1 では URL 拡張子 + magic bytes で十分であり、スコープ外。

#### R4 — ドキュメント（docs ride with the change / `pnpm check:docs-impact`）

- `knowledge/product/orchestration/perception-playbook.md`（+ `.ja.md`）：§2 の表「Web page (URL)」を `pnpm kyberion read <url>` に更新、§5 "Not covered" から URL 行を削除、§3 の例に `read <url>` を追加。
- `knowledge/product/orchestration/document-file-reading-playbook.md`（+ `.ja.md`）：16–18 行の「URLs are refused — save them with network:fetch first」を書き換え、URL 直接 read と egress セマンティクス（GET のみ・承認不要・deny/warn/allow）を記述。pipeline 経路の ctx 蒸留（preview envelope）の注意を Traps に追記。
- `knowledge/product/orchestration/capability-verb-inventory.md` §3：URL 行を「folded / resolved 2026-11-25」に更新し、egress ゲートの所在（`secureFetch` + `runExternalOperation`、動詞は引数解析のみ）を記録。
- `AGENTS.md` §2 の知覚箇条書きは既に「documents / web → `kyberion read`」と記述があり、本変更でコードが記述に追いつく形。表現を確認し必要なら微調整。
- `cli-commands.json` + ロケールカタログの `read` 説明文を URL 対応込みに更新。

## 影響範囲（変更ファイル候補）

| ファイル                                                                                                        | 変更                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `scripts/cli/cli-read.ts`                                                                                       | URL 分岐・fetch 経路・フォーマット推定・READ_USAGE                              |
| `scripts/cli/cli-read.test.ts`                                                                                  | URL テスト群に置換（fetch 注入で hermetic）                                     |
| `scripts/cli/cli-error-contract.test.ts`                                                                        | URL の assertion 更新                                                           |
| `libs/core/media/document-reader.ts`（必要なら）                                                                | URL 用フォーマット推定ヘルパー置き場（Buffer 入力は既対応・本体変更なしでも可） |
| `knowledge/product/governance/cli-commands.json` + ロケールカタログ                                             | `read` の説明文                                                                 |
| `perception-playbook.{md,ja.md}` / `document-file-reading-playbook.{md,ja.md}` / `capability-verb-inventory.md` | 記述更新                                                                        |

`secureFetch`・network-actuator・ADF エンジン本体は変更しない（既存のガバナンス境界を再利用）。

## 検証

- `pnpm kyberion read https://sre-magazine.net/articles/7/aoto/` が Markdown を出力（本計画の動機になった記事で実測）。
- `pnpm kyberion read <pdf-url>` が PDF を読める、`--json` / `--out` 併用可。
- `file:` スキーム・ローカルネットワーク URL が拒否される。
- `pnpm check:docs-impact` が本変更で未更新を指摘しない。
- vitest の `cli-read.test.ts` / `cli-error-contract.test.ts` がグリーン。

## スコープ外（今回扱わない）

- ADF / パイプライン内での URL→digest 1ステップ化（`media:document_digest` の `url` 入力や pipeline-template 追加）。ctx 蒸留の制約と合わせて別計画。
- GET 以外のメソッド・認証付きフェッチ・非許可ホストへの承認必須化（egress-policy モードの話であり `read` の責務ではない）。
- ローカルネットワーク URL の許可（`kyberion_allow_local_network` を CLI に出すのは別審査）。
