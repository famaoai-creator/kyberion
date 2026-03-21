# IOS-Actuator Examples

iOS-Actuator 固有の sample pipeline を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- iOS simulator automation の検証・テンプレート・再現用 pipeline は `libs/actuators/ios-actuator/examples/` に置く

前提:

- `xcrun` と `simctl` がローカルに存在すること
- boot 済み iOS Simulator があること
- 生成 artifact は `active/shared/tmp/` 配下へ保存される
- app 固有 selector / bundle ID は `knowledge/public/orchestration/mobile-app-profiles/` に置く

実行例:

```bash
node dist/libs/actuators/ios-actuator/src/index.js --input libs/actuators/ios-actuator/examples/simctl-health-check.json
```

利用可能な examples:

- `simctl-health-check.json`:
  `xcrun simctl` の有無と利用可能 simulator 一覧を確認する
- `ios-observability-template.json`:
  app profile から app を起動し、simulator screenshot を保存する
- `ios-deep-link-template.json`:
  deep link を開いて screenshot を保存する
- `ios-boot-and-observe-template.json`:
  named simulator を boot して app を起動し、screenshot を保存する
- `ios-install-launch-template.json`:
  local `.app` bundle を simulator に install してから起動し、screenshot を保存する
- `ios-webview-session-handoff.json`:
  native app 側の cookie/storage を WebView/browser 向け handoff artifact として出力する
- `ios-runtime-webview-handoff-template.json`:
  app container 内へ出力された WebView session JSON を読み、browser 側へ渡せる artifact にする
