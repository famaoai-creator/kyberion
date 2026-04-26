# Approval-Actuator Examples

`approval-actuator` 固有のサンプル入力を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- `approval-actuator` 専用の検証・再現・テンプレート入力は `libs/actuators/approval-actuator/examples/` に置く

実行例:

```bash
node dist/libs/actuators/approval-actuator/src/index.js --input libs/actuators/approval-actuator/examples/create-secret-mutation-approval.json
```

利用可能な examples:

- `create-secret-mutation-approval.json`:
  秘密情報の変更申請を作成する。`requestKind: secret_mutation` の承認ワークフローを持つ入力例
