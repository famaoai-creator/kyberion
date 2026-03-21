# Mobile App Profile Index

`mobile-app-profile-index.schema.json` は `knowledge/public/orchestration/mobile-app-profiles/index.json` の catalog contract です。

想定用途:

- 共有 mobile profile catalog の一覧契約を固定する
- CLI の `mobile-profiles` discovery を壊れにくくする
- `id`、`platform`、`path`、`description` などの必須 metadata を揃える

最小の重要フィールド:

- `profiles[].id`
- `profiles[].platform`
- `profiles[].title`
- `profiles[].path`
- `profiles[].description`

サンプルは `mobile-app-profile-index.example.json` を参照。
