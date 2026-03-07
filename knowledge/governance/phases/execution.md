# Phase Protocol: ④ Mission Execution

## Goal
物理的な変更を、論理的に正当化し、検証しながら、最小単位（Micro-tasking）で執行する。

## Physical Enforcement
作業中のマイルストーンごとに、AIエージェントは必ず以下のコマンドを実行して作業のトランザクションを確定させなければならない。

- **Command**: `npx tsx scripts/mission_controller.ts checkpoint <TASK_ID> "<NOTE>"`
- **Validation**:
  - `git commit` による履歴の永続化。
  - `mission-state.json` へのチェックポイントの記録。

---
*Status: Mandated by GEMINI.md*
