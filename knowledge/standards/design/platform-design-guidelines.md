# Platform Design Guidelines: iOS, Android, and Web

このドキュメントは、iOS (HIG), Android (Material Design), および Web の各プラットフォームにおけるデザインの原則とベストプラクティスをまとめたものである。

## 1. iOS: Human Interface Guidelines (HIG)

Appleが提唱する、ユーザー体験の質を高めるためのガイドライン。

### 主要な原則
- **Clarity (明快さ)**: テキストは読みやすく、アイコンは意味が正確に伝わり、装飾は控えめに。
- **Deference (控えめさ)**: コンテンツが主役。UIはそれを邪魔せず、流れるような操作を支援する。
- **Depth (奥行き)**: レイヤー構造や視覚的な重なりを利用して、情報の階層を伝える。

### モバイル特有のパターン
- **Safe Area**: ノッチや画面下部のホームインジケータを避けるレイアウト。
- **Tap Targets**: 最低 44x44 pt のクリック領域を確保。
- **SF Symbols**: システム標準のアイコンセットを活用した一貫性。

## 2. Android: Material Design (M3)

Googleが提唱する、物理的な法則（質感、影、動き）をデザインに取り入れたシステム。

### 主要な原則
- **Material is the metaphor**: 画面上の要素は、現実世界の紙やインクのような「物質」として振る舞う。
- **Bold, graphic, intentional**: 大胆な色彩、大きなタイポグラフィ、意図的な余白。
- **Motion provides meaning**: 動きはユーザーの注意を引き、操作の結果を視覚的に説明する。

### 特有のコンポーネント
- **Floating Action Button (FAB)**: 画面の主要なアクションを強調。
- **Navigation Rail / Bottom Navigation**: 大画面と小画面の両方に対応したナビゲーション。
- **Dynamic Color**: ユーザーの壁紙に合わせたパーソナライズされた配色。

## 3. Web: Accessibility & Usability (WCAG)

Web標準および、全てのユーザーが利用可能なユニバーサルデザイン。

### 主要な指標
- **WCAG 2.1/2.2**: Webアクセシビリティの国際基準。A, AA, AAA のレベルがある。
- **Contrast Ratio**: テキストと背景のコントラスト比は最低 4.5:1 (AA) 以上。
- **Keyboard Navigable**: マウスなしで、Tabキーのみですべての操作が可能であること。

### レスポンシブ設計
- **Mobile First**: 小さな画面から設計し、段階的に拡張する。
- **Core Web Vitals**: LCP (読み込み速度), FID (インタラクティブ性), CLS (視覚的安定性) を最適化。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
