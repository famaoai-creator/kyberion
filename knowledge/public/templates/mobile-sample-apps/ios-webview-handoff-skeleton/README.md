# iOS WebView Handoff Skeleton

最小構成の iOS sample app skeleton です。SwiftUI app、WebView login 画面、launch argument による debug-only handoff export の wiring を含みます。

## Files

- [`ExampleIOSMobileApp.swift`](./ExampleIOSMobileApp.swift)
- [`RootView.swift`](./RootView.swift)
- [`WebViewScreen.swift`](./WebViewScreen.swift)
- [`SessionRepository.swift`](./SessionRepository.swift)
- [`IOSWebViewSessionReader.swift`](./IOSWebViewSessionReader.swift)
- [`DebugFeatureFlags.swift`](./DebugFeatureFlags.swift)

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

これは [`example-ios-login-passkey.json`](../../../orchestration/mobile-app-profiles/example-ios-login-passkey.json) と揃っています。
