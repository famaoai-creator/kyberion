# Artifact-Actuator Examples

`artifact-actuator` 固有のサンプル入力を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- `artifact-actuator` 専用の検証・再現・テンプレート入力は `libs/actuators/artifact-actuator/examples/` に置く

実行例:

```bash
node dist/libs/actuators/artifact-actuator/src/index.js --input libs/actuators/artifact-actuator/examples/write-governed-artifact.json
```

利用可能な examples:

- `write-governed-artifact.json`:
  governed artifact の JSON レコードを書き込む最小例
- `write-delivery-pack.json`:
  delivery pack の生成・書き込みを行う例。オーケストレーション側の template_path としても使う
