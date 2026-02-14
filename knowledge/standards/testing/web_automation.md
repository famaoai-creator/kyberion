# Web Test Automation Standard

モダンなWebアプリケーションのための、高速かつ安定したE2Eテスト基準。

## 1. フレームワーク選定: Playwright
- **理由**: ブラウザの並列実行、自動待機（Auto-wait）、強力なトレース表示、モバイルエミュレーション機能。
- **構成**: TypeScript + Playwright Test。

## 2. 設計パターン: Page Object Model (POM)
- 画面上の要素（Selectors）と操作（Actions）をクラスに隠蔽し、テストシナリオ側には「何をしたいか（例: `page.login()`）」だけを記述する。
- セレクタは `data-testid` を優先し、HTML構造の変化に強いテストを作る。

## 3. 視覚的回帰テスト (Visual Regression)
- CSSの微細な変化を検知するため、`expect(page).toHaveScreenshot()` を活用。
- `ux-visualizer` で定義した「理想の画面」との差分を自動チェックする。

---
*Created: 2026-02-14 | Rigorous Validator*
