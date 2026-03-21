# WebView Session Handoff

`webview-session-handoff.schema.json` は mobile native context から WebView / browser context へ認証状態を引き継ぐための artifact contract です。

想定用途:

- mobile app の native login 後に WebView へ遷移する
- cookie / localStorage / sessionStorage / header ベースの state を browser-actuator に引き渡す
- Android / iOS / Browser 間で handoff artifact を共通化する

最小の重要フィールド:

- `kind`
- `target_url`
- `cookies`
- `local_storage`
- `session_storage`
- `source`
