# Mobile Test Automation Standard

iOS/Android アプリケーションにおける、デバイス実機とシミュレータを組み合わせた自動化基準。

## 1. ツール戦略
- **Appium**: 業界標準。Webview（ハイブリッドアプリ）を含む複雑な制御が必要な場合。
- **Maestro**: 次世代のモダンな選択。宣言的なYAML形式で記述でき、AIエージェントとの親和性が極めて高い。

## 2. 実行環境の選定
- **Local**: 開発中のデバッグ用（iOS Simulator / Android Emulator）。
- **Cloud Device Farm**: 本番前（BrowserStack, AWS Device Farm）。多機種デバイスでの並列実行。

## 3. モバイル特有のチェックポイント
- **ネットワークエミュレーション**: 3G/4G/Offline 状態でのアプリの挙動。
- **生体認証バイパス**: TouchID/FaceID のモック化。
- **プッシュ通知**: 通知受信後のディープリンク遷移。

---
*Created: 2026-02-14 | Rigorous Validator*
