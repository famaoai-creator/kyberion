# Test Case ADF

`test-case-adf.schema.json` は `ui-flow-adf` から起こした試験項目 inventory の最小 contract です。

想定用途:

- state transition ベースの試験項目生成
- browser/mobile actuator 実行前の inventory 化
- evidence 要件と backend の分離

最小の重要フィールド:

- `app_id`
- `cases[].case_id`
- `cases[].steps`
- `cases[].expected`
- `cases[].automation_backend`
