---
category: Changed
---

- **media / modeling の読み取り専用ステップ op を宣言** — `modeling:read_json` / `read_file`、`media:json_read` / `document_digest` を `step_ops` で `read`（`resource_ref_from: path`）として宣言。パラメータ名と副作用を実装で確認できた op のみ（`pptx_extract` などスクラッチに書く op は `write` のまま）。
