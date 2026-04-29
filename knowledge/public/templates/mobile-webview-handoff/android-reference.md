# Android WebView Handoff Adapter Reference

debug build または internal QA build で、authenticated WebView state を `webview-session-handoff` JSON として出力するための共有 reference です。

## Core Rules

- release variant には含めない
- explicit trigger でのみ export する
- session rehydration に必要なものだけ出す
- canonical path は `context.filesDir/kyberion/webview-session.json`
- actuator pickup 用 mirror は必要な場合だけ `/sdcard/kyberion/<app-id>/...`

## Shared Stub Files

- [`KyberionHandoffModels.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffModels.kt)
- [`KyberionHandoffStorage.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffStorage.kt)
- [`KyberionHandoffExporter.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffExporter.kt)
- [`KyberionHandoffTriggerReceiver.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffTriggerReceiver.kt)

## Profile Alignment

- [`example-mobile-login-passkey.json`](/Users/famao/kyberion/knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json)

## Orchestration

- capture:
  [`android-runtime-webview-handoff-template.json`](/Users/famao/kyberion/libs/actuators/android-actuator/examples/android-runtime-webview-handoff-template.json)
- browser import:
  [`android-runtime-session-handoff-import.json`](/Users/famao/kyberion/libs/actuators/browser-actuator/examples/android-runtime-session-handoff-import.json)
- end-to-end runner:
  [`mobile-webview-handoff-runner-android.json`](/Users/famao/kyberion/pipelines/mobile-webview-handoff-runner-android.json)
