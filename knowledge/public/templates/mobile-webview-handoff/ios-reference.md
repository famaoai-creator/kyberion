# iOS WebView Handoff Adapter Reference

debug scheme または internal simulator build で、authenticated WebView state を `webview-session-handoff` JSON として出力するための共有 reference です。

## Core Rules

- release scheme には含めない
- explicit launch arg、QA action、または debug URL scheme でのみ export する
- session rehydration に必要なものだけ出す
- canonical relative path は `Library/Application Support/kyberion/webview-session.json`
- actuator は `simctl get_app_container` 経由で回収する

## Shared Stub Files

- [`KyberionHandoffModels.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffModels.swift)
- [`KyberionHandoffStorage.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffStorage.swift)
- [`KyberionHandoffExporter.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffExporter.swift)
- [`KyberionHandoffCoordinator.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffCoordinator.swift)

## Profile Alignment

- [`example-ios-login-passkey.json`](/Users/famao/kyberion/knowledge/public/orchestration/mobile-app-profiles/example-ios-login-passkey.json)

## Orchestration

- capture:
  [`ios-runtime-webview-handoff-template.json`](/Users/famao/kyberion/libs/actuators/ios-actuator/examples/ios-runtime-webview-handoff-template.json)
- browser import:
  [`ios-runtime-session-handoff-import.json`](/Users/famao/kyberion/libs/actuators/browser-actuator/examples/ios-runtime-session-handoff-import.json)
- end-to-end runner:
  [`mobile-webview-handoff-runner-ios.json`](/Users/famao/kyberion/pipelines/mobile-webview-handoff-runner-ios.json)
