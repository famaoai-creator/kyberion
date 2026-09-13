# doc-drop — ファイルドロップ → ingest handoff → Kyberion

meeting-notepad / sketch-input と同型の **127.0.0.1 限定ローカルポート (8153)**。PDF・画像・txt/md/docx をドロップし、`handoff.json` を書き出して Kyberion に渡す（自動 knowledge commit なし）。

## 使い方

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/doc-drop/server.ts \
  [--out active/shared/tmp/doc-drop] \
  [--instruction "この資料をパースして"] \
  [8153]
```

- UI: ドラッグ&ドロップ / ファイル選択 / 任意カメラ撮影、添付一覧、指示、Hand off
- POST `/export` … `sessions/<id>/attachments/` + `handoff.json` (`kind: doc-drop-handoff`)
  - `suggested_ops`: `ingest:parse_document`, `vision:ocr_image`
- 上限: body 24MiB / ファイル 12MiB
- トークンヘッダ: `X-DDROP-Token` または `X-DOC-Token`
- 書き出し成功時は `active/shared/observability/doc-drop/.../receipts/` に証跡を残す

## Dry-run

```bash
node_modules/.bin/tsx scripts/doc-drop/server.ts --dry-run --json
```

## 注意

- ローカルトークンは人間承認の代替ではない（artifact-review-port 分類）。
- 127.0.0.1 のみで listen する。knowledge への自動コミットは行わない。
