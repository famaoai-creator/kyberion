# Browser-Actuator Examples

Browser-Actuator 固有のサンプル pipeline を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- Browser-Actuator 専用の検証・サンプル・再現用 pipeline は `libs/actuators/browser-actuator/examples/` に置く
- `manifest.json` の `recovery_policy` は selector 不安定性や描画待ちの既定 retry を定義する

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
- `test-session-recording.json`:
  Web アプリ試験を trace + video 付きで実行し、試験後に artifact を確認するテンプレート
- `passkey-webauthn-io.json`:
  passkey の register / authenticate / delete
- `webview-session-handoff-import.json`:
  mobile actuator が出力した session handoff artifact を browser context に import し、cookies/storage を復元する
- `android-runtime-session-handoff-import.json`:
  Android runtime handoff artifact を import して browser 側で round-trip export する
- `ios-runtime-session-handoff-import.json`:
  iOS runtime handoff artifact を import して browser 側で round-trip export する
- `web-runtime-session-handoff-export-template.json`:
  ローカル起動中の Web app から current browser session を handoff artifact として export する
- `web-runtime-session-handoff-import.json`:
  Web runtime handoff artifact を import して browser 側で round-trip export する
- `moppy-rakuten-travel-simulation.json`:
  `points-portal-clickout-usecase` の実行例。専用 Chrome プロファイルで Moppy から楽天トラベルへの導線を検証し、Moppy 広告詳細と楽天トラベル着地の証跡を保存する。予約確定・決済・session handoff export は行わない
