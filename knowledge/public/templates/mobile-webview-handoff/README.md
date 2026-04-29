# Mobile WebView Handoff Templates

共有用の debug-only handoff adapter template です。mission 配下ではなく `knowledge/public` 側に置き、複数ミッションや複数 app team から再利用できるようにしています。

- Android reference:
  [`android-reference.md`](./android-reference.md)
- iOS reference:
  [`ios-reference.md`](./ios-reference.md)
- Android stubs:
  [`android/KyberionHandoffModels.kt`](./android/KyberionHandoffModels.kt)
  [`android/KyberionHandoffStorage.kt`](./android/KyberionHandoffStorage.kt)
  [`android/KyberionHandoffExporter.kt`](./android/KyberionHandoffExporter.kt)
  [`android/KyberionHandoffTriggerReceiver.kt`](./android/KyberionHandoffTriggerReceiver.kt)
- iOS stubs:
  [`ios/KyberionHandoffModels.swift`](./ios/KyberionHandoffModels.swift)
  [`ios/KyberionHandoffStorage.swift`](./ios/KyberionHandoffStorage.swift)
  [`ios/KyberionHandoffExporter.swift`](./ios/KyberionHandoffExporter.swift)
  [`ios/KyberionHandoffCoordinator.swift`](./ios/KyberionHandoffCoordinator.swift)

これらは sample app ではなく、既存アプリへ移植するための reference 実装です。

sample app skeleton が必要な場合は:

- [`mobile-sample-apps/README.md`](../mobile-sample-apps/README.md)
