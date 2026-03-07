# Phase Protocol: ③ Alignment

## Goal
主権者の意図（Intent）を解釈し、勝利条件（Victory Conditions）を定義して、ミッションを物理的に「起動」する。

## Physical Enforcement
Alignment が完了した際、AIエージェントは必ず以下のコマンドを実行してミッションを「Active」状態にしなければならない。

- **Command**: `npx tsx scripts/mission_controller.ts start <MISSION_ID> <PERSONA>`
- **Validation**:
  - `my-identity.json` の存在確認。
  - ミッション専用ブランチ (`mission/id`) の作成と切り替え。
  - `mission-state.json` の初期化。

---
*Status: Mandated by GEMINI.md*
