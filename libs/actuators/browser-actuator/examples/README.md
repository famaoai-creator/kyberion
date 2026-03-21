# Browser-Actuator Examples

Browser-Actuator 固有のサンプル pipeline を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- Browser-Actuator 専用の検証・サンプル・再現用 pipeline は `libs/actuators/browser-actuator/examples/` に置く

実行例:

```bash
node dist/libs/actuators/browser-actuator/src/index.js --input libs/actuators/browser-actuator/examples/passkey-webauthn-io.json
```

利用可能な examples:

- `explore-and-export.json`:
  ページ探索、snapshot、screenshot、Playwright/ADF export
- `multi-tab-observability.json`:
  複数タブ、network capture、screenshot
- `operator-pause-template.json`:
  手動介入ありの headed browser テンプレート
- `passkey-webauthn-io.json`:
  passkey の register / authenticate / delete
