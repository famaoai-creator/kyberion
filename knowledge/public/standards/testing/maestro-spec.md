---
title: Maestro Syntax Standard (v1.35.0)
category: Standards
tags: [standards, testing, maestro, spec]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Maestro Syntax Standard (v1.35.0)

このドキュメントは、Maestro において AI が構文を誤認しないための「絶対的な正解」である。

## 1. 待機 (Wait/Sleep)
- **`- tapOn: ...` に `retryTapIfNoChange: true` を使う**: (推奨) 要素が出るまで待機。
- **`- waitForAnimationToEnd`**: アニメーション完了まで待機。
- **`- wait: 2000`**: (注意) これはトップレベルではなく、特定の環境でしか動作しない場合がある。
- **`- stopApp` / `- launchApp`**: アプリの再起動。

## 2. スクロール
- **`- scrollUntilVisible: { element: "Text", direction: DOWN }`**: 要素が見えるまでスクロール。

## 3. 入力
- **`- inputText: "Text"`**: フォーカスされている要素にテキスト入力。
- **`- eraseText: 10`**: 文字の削除。

## 4. 特殊アクション
- **`- authenticate`**: 生体認証のパス。
- **`- back`**: Android/iOS の「戻る」ボタン。
- **`- pressKey: "Home"`**: ホームボタン。

## 5. 画面遷移とフロー制御 (Flow Control)
- **`- runFlow: file.yaml`**: 他のテストファイルをサブルーチンとして実行。複雑な遷移（A->B->A->C）の部品化に使用。
- **`- stopApp`**: 状態をリセットして次のテストへ進む際に使用。
- **`onFlowStart` / `onFlowComplete`**: フローの前後に実行するフック。

---
*Reference for Kyberion AI to avoid syntax errors and ensure stateful coverage.*
