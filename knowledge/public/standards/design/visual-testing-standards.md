---
title: Visual & Design Testing Standards
category: Standards
tags: [standards, design, visual, testing]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Visual & Design Testing Standards

このドキュメントは、アプリケーションの視覚的品質（色、タイポグラフィ、ラベル、アクセシビリティ）を保証するための試験戦略である。

## 1. 視覚的回帰テスト (Visual Regression Testing: VRT)

「見た目の差分」を自動検知する手法。色やレイアウトの意図しない変更を防ぐ。

### 実装のポイント
- **Baseline**: 「正解」とされるスクリーンショットを保存しておく。
- **Snapshot Comparison**: 新しいコードでの実行結果と Baseline をピクセル単位で比較。
- **Threshold**: 許容する微細な差分（レンダリングの揺れ等）を 0.1% 等で定義。

## 2. ラベルとアクセシビリティの監査

### 自動チェック項目
- **テキストの視認性**: 背景色と文字色のコントラスト比が WCAG 基準（4.5:1）を満たしているか。
- **動的テキスト**: フォントサイズを大きくした際に、ラベルが切れたり重なったりしないか。
- **存在確認**: 全てのボタンや画像に、読み上げ用のラベル（`accessibilityLabel`）が付与されているか。

## 3. デザイン・トークンの遵守

コード内でカラーコード（`#FFFFFF`）を直接記述せず、デザイン・トークン（`Color.BrandPrimary`）を使用しているかを静的にチェックする。これにより、一括での色変更を容易にし、一貫性を担保する。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
