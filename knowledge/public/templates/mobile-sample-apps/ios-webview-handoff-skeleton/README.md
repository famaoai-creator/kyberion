# iOS WebView Handoff Skeleton

最小構成の iOS sample app skeleton です。SwiftUI app、WebView login 画面、launch argument による debug-only handoff export の wiring を含みます。

## Files

- [`ExampleIOSMobileApp.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/ExampleIOSMobileApp.swift)
- [`RootView.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/RootView.swift)
- [`WebViewScreen.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/WebViewScreen.swift)
- [`SessionRepository.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/SessionRepository.swift)
- [`IOSWebViewSessionReader.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/IOSWebViewSessionReader.swift)
- [`DebugFeatureFlags.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/ios-webview-handoff-skeleton/DebugFeatureFlags.swift)

## Trigger

simulator 起動時に launch arg を付与します。

```bash
xcrun simctl launch booted com.example.iosmobile \
  -kyberion-handoff \
  -kyberion-handoff-reason manual_debug
```

## Expected Export

- relative path:
  `Library/Application Support/kyberion/webview-session.json`

これは [`example-ios-login-passkey.json`](/Users/famao/kyberion/knowledge/public/orchestration/mobile-app-profiles/example-ios-login-passkey.json) と揃っています。
