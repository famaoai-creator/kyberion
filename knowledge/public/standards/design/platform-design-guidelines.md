---
title: Platform Design Guidelines: iOS, Android, and Web
category: Standards
tags: [standards, design, platform, guidelines]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Platform Design Guidelines: iOS, Android, and Web

このドキュメントは、iOS (HIG), Android (Material Design), および Web の各プラットフォームにおけるデザインの原則とベストプラクティスをまとめたものである。

## 1. iOS: Human Interface Guidelines (HIG)

Appleが提唱する、ユーザー体験の質を高めるためのガイドライン。

### 主要な原則
- **Clarity (明快さ)**: テキストは読みやすく、アイコンは意味が正確に伝わり、装飾は控えめに。
- **Deference (控えめさ)**: コンテンツが主役。UIはそれを邪魔せず、流れるような操作を支援する。
- **Depth (奥行き)**: レイヤー構造や視覚的な重なりを利用して、情報の階層を伝える。

### iOS 特有のアンチパターン
- **Custom Back Button**: システム標準の「戻る」ボタンを独自実装して、ジェスチャーを壊す。
- **Bottom Tabs > 5**: 下部タブバーに 5 つ以上の項目を詰め込む（UI が煩雑になる）。

### Android 特有のアンチパターン
- **iOS-style Navigation**: Android で iOS のような戻るボタンをヘッダー左側に置く（ハードウェア/ジェスチャー戻ると重複する）。
- **Fixed Pixels**: `px` でサイズを固定する（`dp`/`sp` を使わないと画面密度で崩れる）。

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
*Created by Kyberion Ecosystem Architect - 2026-02-28*
