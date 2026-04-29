# Mobile App Profiles

モバイルアプリ固有の selector、launch component、platform metadata を共通管理する catalog です。

- profile 本体は `knowledge/public/orchestration/mobile-app-profiles/*.json`
- 一覧は `knowledge/public/orchestration/mobile-app-profiles/index.json`
- Android Actuator の high-level op は `app_profile` または `app_profile_from` で profile を受け取る
- schema は `knowledge/public/schemas/mobile-app-profile.schema.json`

CLI:

```bash
node dist/scripts/cli.js mobile-profiles
node dist/scripts/cli.js mobile-profiles example-mobile-login-passkey
```

Reference handoff adapter templates:

- [`mobile-webview-handoff/README.md`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/README.md)
- [`mobile-sample-apps/README.md`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/README.md)
