# Mobile App Profile

`mobile-app-profile.schema.json` は mobile actuator 用の app-specific selector contract です。

想定用途:

- Android / iOS アプリごとの selector を pipeline から分離する
- `launch_app`、`fill_login_form`、`authenticate_with_passkey` などの高水準 op へ profile を渡す
- app ごとの差分を `knowledge/public/orchestration/mobile-app-profiles/` で共通管理する

最小の重要フィールド:

- `app_id`
- `platform`
- `package_name`
- `selectors.login`
- `selectors.passkey`

代表例は `knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json` を参照。
