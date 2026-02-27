# Mobile Test Automation Standard (Deep-Dive Edition)

iOS/Android アプリケーションにおける、高品質・高効率な自動化の実装ガイドライン。

## 1. 推奨フレームワーク: Maestro (Declarative Testing)

Maestroは、YAML形式で動作を記述する「AI親和性が極めて高い」次世代ツールである。

### A. 基本的なフローの記述例 (Login Scenario)

```yaml
appId: com.example.app
---
- launchApp
- tapOn: 'ユーザー名'
- inputText: 'eval-user-01'
- tapOn: 'パスワード'
- inputText: 'password123'
- tapOn: 'ログイン'
- assertVisible: 'ホーム画面'
```

### B. 高度なインタラクション

- **Scroll**: `scroll` または `scrollUntilVisible` を使い、動的なコンテンツに対応する。
- **Conditionals**: `runScript` を用いて、特定条件下でのみ実行するロジックを組む。
- **Deep Links**: `openLink: "myapp://settings"` で、特定の画面へ直接遷移し、テスト時間を短縮する。

## 2. 要素特定（Selectors）の鉄則

モバイルUIは構造が変化しやすいため、以下の優先順位で要素を特定する。

1.  **Accessibility ID (Label)**: 最優先。OSレベルで付与された識別子。
2.  **Text**: 文言が固定されているボタン等に使用。
3.  **Point (座標)**: 最終手段。解像度依存するため極力避ける。

## 3. 実践的ノウハウ (The Professional Way)

### A. Wait & Flakiness 対策

- Maestroは自動待機を持つが、複雑なAPI通信を伴う場合は `- assertVisible: "要素名"` を明示的に挟み、画面の「静止」を確認してから次のアクションへ移る。

### B. VoltMX / Hybrid App への対応

- Webview内部の要素は、`native` モードだけでなく `browser` モードのセレクタが必要になる場合がある。
- `accessibilityConfig` をコード側で適切に設定し、AIが要素を見失わないように開発側にフィードバックを出す。

### C. CI/CD 統合 (GitHub Actions)

- macOS runner を使用し、`Maestro Cloud` またはローカルシミュレータをバックグラウンドで起動して実行する。
- 失敗時には、自動で `.mp4` 動画とスクリーンショットを `evidence/` へ保存し、Chronos Mirror に掲示する。

---

_Updated: 2026-02-14 | Rigorous Validator & Focused Craftsman_
