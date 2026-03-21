# Web App Profile

`web-app-profile.schema.json` は Browser-Actuator と Web sample app skeleton の間で使う app-specific contract です。

想定用途:

- login route や guarded route を pipeline から分離する
- Browser-Actuator の session export/import と Web app の debug hook を揃える
- app ごとの差分を `knowledge/public/orchestration/web-app-profiles/` で共通管理する

最小の重要フィールド:

- `app_id`
- `title`
- `base_url`
- `guarded_routes`
- `session_handoff`
- `debug_routes.session_export`

代表例は `knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json` を参照。
