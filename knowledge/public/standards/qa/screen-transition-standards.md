---
title: Screen Transition & State Machine Testing Standards
category: Standards
tags: [standards, qa, screen, transition]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Screen Transition & State Machine Testing Standards

このドキュメントは、単一画面の検証を超え、アプリケーションの「状態遷移」と「画面遷移パス」の網羅性を保証するための標準規約である。

## 1. 遷移網羅の 3 レベル (Coverage Levels)

### Level 1: 画面網羅 (Node Coverage)
- **定義**: アプリケーション内の全ての画面（View/Activity）を最低 1 回は訪問する。
- **目的**: 画面のクラッシュや基本的な表示不備を検知する。

### Level 2: 遷移網羅 (Edge Coverage)
- **定義**: 全ての画面遷移ボタン、リンク、スワイプ操作による「矢印」を最低 1 回は実行する。
- **目的**: ボタンの反応なしや、リンク切れを検知する。

### Level 3: パス網羅 (Logic Path Coverage)
- **定義**: 特定の業務ロジックに基づいた連続する遷移を検証する。
    - **A -> B -> C**: 正常系。
    - **A -> B -> A**: 戻る操作の検証（状態が保持されているか）。
    - **A -> B -> (Error) -> A**: 異常系からの復帰。
    - **A -> B -> C -> A**: 循環パス（再エントリー時の不整合がないか）。

## 2. 状態遷移マトリクス (State Transition Matrix)

複雑な遷移を整理するために、マトリクスを使用して「現在の画面」から「遷移可能な画面」を定義する。

| From \ To | Home | Detail | Settings | Login |
| :--- | :---: | :---: | :---: | :---: |
| **Home** | - | ○ | ○ | △ (非ログイン時) |
| **Detail** | ○ (Back) | - | - | - |
| **Settings**| ○ (Save) | - | - | ○ (Logout) |
| **Login** | ○ (Success)| - | - | - |

## 3. サイクリック・テストの重要性 (A -> B -> A)

「戻る」操作や「再入」操作における不具合は、状態管理（State Management）の不備に起因することが多い。

- **重複エントリー**: 同じ画面に何度も入ることで、リスナーが重複登録されメモリリークや二重発火が起きていないか。
- **データの整合性**: 画面Bで編集してAに戻った際、Aの表示が最新の状態に更新されているか。
- **スタック管理**: ナビゲーションスタックが積み上がりすぎてアプリが重くなっていないか。

## 4. 自動化戦略 (Maestro & Playwright)

### Maestro: サブフローの活用
共通の遷移（例：ログイン、設定への遷移）を個別の YAML ファイルに切り出し、`runFlow` で呼び出すことで、複雑なパス（A->B->A->C）を簡潔に記述する。

### 状態リセット
各テストケースの開始前に、アプリの状態（DB、キャッシュ、ログインセッション）を「クリーン」にするか「特定の状態」から始めるかを明示する。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
