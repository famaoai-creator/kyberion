# iOS WebView Handoff Adapter Reference

debug scheme または internal simulator build で、authenticated WebView state を `webview-session-handoff` JSON として出力するための共有 reference です。

## Core Rules

- release scheme には含めない
- explicit launch arg、QA action、または debug URL scheme でのみ export する
- session rehydration に必要なものだけ出す
- canonical relative path は `Library/Application Support/kyberion/webview-session.json`
- actuator は `simctl get_app_container` 経由で回収する

## Shared Stub Files

- [`KyberionHandoffModels.swift`](./ios/KyberionHandoffModels.swift)
- [`KyberionHandoffStorage.swift`](./ios/KyberionHandoffStorage.swift)
- [`KyberionHandoffExporter.swift`](./ios/KyberionHandoffExporter.swift)
- [`KyberionHandoffCoordinator.swift`](./ios/KyberionHandoffCoordinator.swift)

## Profile Alignment

- [`example-ios-login-passkey.json`](../../orchestration/mobile-app-profiles/example-ios-login-passkey.json)

## Orchestration

- capture:
  [`ios-runtime-webview-handoff-template.json`](../../../../libs/actuators/ios-actuator/examples/ios-runtime-webview-handoff-template.json)
- browser import:
  [`ios-runtime-session-handoff-import.json`](../../../../libs/actuators/browser-actuator/examples/ios-runtime-session-handoff-import.json)
- end-to-end runner:
  [`mobile-webview-handoff-runner-ios.json`](../../../../pipelines/mobile-webview-handoff-runner-ios.json)
