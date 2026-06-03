# UI Flow ADF

`ui-flow-adf.schema.json` は画面、route、guard、transition を中立表現に落とすための最小 contract です。

想定用途:

- Web profile から route map を起こす
- mobile/native screen flow を同じ shape に寄せる
- 試験項目生成の入力にする

最小の重要フィールド:

- `app_id`
- `platform`
- `states`
- `transitions`
- `entry_state`
