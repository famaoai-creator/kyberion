# Mobile WebView Session Handoff

モバイル native context で確立した認証状態を、governed artifact として browser/WebView automation に受け渡すための手順です。

## Goal

対象フロー:

1. mobile app が認証済み状態になる
2. debug-only adapter が `webview-session-handoff` JSON を出力する
3. mobile actuator が artifact を回収する
4. browser actuator が cookies/storage/headers を import する
5. WebView 相当の後続導線を browser 側で継続する

## Contracts

- handoff artifact schema:
  [`webview-session-handoff.schema.json`](../../schemas/webview-session-handoff.schema.json)
- mobile profile schema:
  [`mobile-app-profile.schema.json`](../../schemas/mobile-app-profile.schema.json)
- shared mobile profiles:
  [`mobile-app-profiles/index.json`](../../orchestration/mobile-app-profiles/index.json)

## Shared Templates

- Android reference:
  [`android-reference.md`](../../templates/mobile-webview-handoff/android-reference.md)
- iOS reference:
  [`ios-reference.md`](../../templates/mobile-webview-handoff/ios-reference.md)
- shared stubs:
  [`README.md`](../../templates/mobile-webview-handoff/README.md)
- sample app skeletons:
  [`mobile-sample-apps/README.md`](../../templates/mobile-sample-apps/README.md)

## Orchestration

共通 orchestration pipeline:

- Android:
  [`mobile-webview-handoff-runner-android.json`](../../../../pipelines/mobile-webview-handoff-runner-android.json)
- iOS:
  [`mobile-webview-handoff-runner-ios.json`](../../../../pipelines/mobile-webview-handoff-runner-ios.json)

## Notes

- production build に exporter を常設しない
- artifact は session rehydration に必要な範囲だけ出す
- release token dump にしない
- Android は `/sdcard/...` mirror を使うか、後段で app-private pull を実装する
- iOS は simulator container から `simctl get_app_container` 経由で回収する
