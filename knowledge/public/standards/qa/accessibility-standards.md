---
title: Accessibility (A11y) Excellence Standards
category: Standards
tags: [standards, qa, accessibility]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Accessibility (A11y) Excellence Standards

このドキュメントは、全てのユーザーが障壁なくサービスを利用できるようにするための、アクセシビリティ設計・検証基準である。

## 1. スクリーンリーダー対応 (Screen Reader Support)
- **Labeling**: 全ての操作要素（Button, Link, Input）に、意味のあるラベルを付与する。
    - iOS: `accessibilityLabel`
    - Android: `contentDescription`
    - Web: `aria-label` または `alt` 属性
- **Roles**: 要素の役割（例：これが「メニュー」なのか「ボタン」なのか）を正しく定義する。

## 2. 操作性とナビゲーション (Operability)
- **Focus Management**: Tabキーや外部スイッチで全ての要素に論理的な順序でフォーカスが当たるか。
- **Tap Targets**: モバイルでは最低 44x44 pt の領域を確保し、誤操作を防ぐ。
- **No Keyboard Traps**: フォーカスが特定のエリアに閉じ込められ、戻れなくなる状態を排除する。

## 3. 視覚的配慮 (Visual Perception)
- **Contrast**: テキストと背景のコントラスト比を 4.5:1 (AA) 以上に保つ。
- **Dynamic Type**: OS の設定で文字サイズを大きくしても、レイアウトが崩れず、内容が読み取れるか。
- **Color Alone**: 情報の伝達を「色のみ」に頼らない（例：エラーを赤色だけでなく「×」アイコンやテキストでも伝える）。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
