# Android WebView Handoff Skeleton

最小構成の Android sample app skeleton です。debug-only handoff export と、WebView login 画面、broadcast trigger の wiring まで含みます。

## Files

- [`settings.gradle.kts`](./settings.gradle.kts)
- [`app/build.gradle.kts`](./app/build.gradle.kts)
- [`AndroidManifest.xml`](./app/src/main/AndroidManifest.xml)
- [`MainActivity.kt`](./app/src/main/java/com/example/mobile/MainActivity.kt)
- [`WebViewLoginActivity.kt`](./app/src/main/java/com/example/mobile/WebViewLoginActivity.kt)
- [`ExampleApplication.kt`](./app/src/main/java/com/example/mobile/ExampleApplication.kt)
- [`SessionRepository.kt`](./app/src/main/java/com/example/mobile/session/SessionRepository.kt)
- [`AndroidWebViewStateReader.kt`](./app/src/main/java/com/example/mobile/handoff/AndroidWebViewStateReader.kt)
- [`DebugHandoffReceiver.kt`](./app/src/main/java/com/example/mobile/handoff/DebugHandoffReceiver.kt)

## Trigger

```bash
adb shell am broadcast \
  -a com.kyberion.debug.EXPORT_WEBVIEW_SESSION \
  --es reason manual_debug
```

## Expected Export

- canonical:
  `filesDir/kyberion/webview-session.json`
- mirrored:
  `/sdcard/kyberion/example-mobile-login-passkey/webview-session.json`

これは [`example-mobile-login-passkey.json`](../../../orchestration/mobile-app-profiles/example-mobile-login-passkey.json) と揃っています。
