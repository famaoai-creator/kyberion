# Mobile WebView Handoff Templates

共有用の debug-only handoff adapter template です。mission 配下ではなく `knowledge/public` 側に置き、複数ミッションや複数 app team から再利用できるようにしています。

- Android reference:
  [`android-reference.md`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android-reference.md)
- iOS reference:
  [`ios-reference.md`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios-reference.md)
- Android stubs:
  [`android/KyberionHandoffModels.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffModels.kt)
  [`android/KyberionHandoffStorage.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffStorage.kt)
  [`android/KyberionHandoffExporter.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffExporter.kt)
  [`android/KyberionHandoffTriggerReceiver.kt`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/android/KyberionHandoffTriggerReceiver.kt)
- iOS stubs:
  [`ios/KyberionHandoffModels.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffModels.swift)
  [`ios/KyberionHandoffStorage.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffStorage.swift)
  [`ios/KyberionHandoffExporter.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffExporter.swift)
  [`ios/KyberionHandoffCoordinator.swift`](/Users/famao/kyberion/knowledge/public/templates/mobile-webview-handoff/ios/KyberionHandoffCoordinator.swift)

これらは sample app ではなく、既存アプリへ移植するための reference 実装です。

sample app skeleton が必要な場合は:

- [`mobile-sample-apps/README.md`](/Users/famao/kyberion/knowledge/public/templates/mobile-sample-apps/README.md)
