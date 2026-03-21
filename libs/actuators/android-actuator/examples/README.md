# Android-Actuator Examples

Android-Actuator 固有の sample pipeline を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- Android native automation の検証・テンプレート・再現用 pipeline は `libs/actuators/android-actuator/examples/` に置く

前提:

- `adb` がローカルに存在すること
- Android Emulator または接続済み Android 端末があること
- 生成 artifact は `active/shared/tmp/` 配下へ保存される
- app 固有 selector は `knowledge/public/orchestration/mobile-app-profiles/` に共通 catalog として外出しできる

実行例:

```bash
node dist/libs/actuators/android-actuator/src/index.js --input libs/actuators/android-actuator/examples/adb-health-check.json
```

利用可能な examples:

- `adb-health-check.json`:
  `adb` の有無と接続端末一覧を確認
- `android-observability-template.json`:
  現在画面の screenshot と UI tree を取得
- `android-deep-link-template.json`:
  deep link 起動後に screenshot を保存
- `android-ui-tree-analysis.json`:
  保存済み UI tree XML を解析し、summary と text match を返す
- `android-ui-node-tap-dry-run.json`:
  UI tree 上の node から tap 対象座標を解決し、dry-run で確認する
- `android-ui-node-input-dry-run.json`:
  editable node を selector で解決し、text input 契約を dry-run で確認する
- `android-ui-node-wait-selector-template.json`:
  text/resource-id/class selector で node を待ち受け、見つかり次第 tap する
- `android-login-form-dry-run.json`:
  email/password/sign-in を高水準 contract で一括解決し、login 実行 plan を確認する
- `android-passkey-auth-dry-run.json`:
  passkey button を高水準 contract で解決し、認証 trigger plan を確認する
- `android-login-passkey-flow-dry-run.json`:
  login 入力から passkey 認証起動までの end-to-end plan を saved UI tree 上で確認する
- `android-login-passkey-flow-template.json`:
  実機または emulator 上で app 起動、login 入力、passkey 起動、screenshot 採取までを通す
- `android-webview-session-handoff.json`:
  native app 側の cookie/storage を WebView/browser 向け handoff artifact として出力する
- `android-runtime-webview-handoff-template.json`:
  app が端末上へ出力した WebView session JSON を pull して、browser 側へ渡せる artifact にする
