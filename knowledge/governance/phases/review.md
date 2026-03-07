# Phase Protocol: ⑤ Review & Distillation

## Goal
実行したミッションの知見を蒸留（Distill）し、環境をクリーンアップしてアーカイブする。

## Directive
Distill both successes and failures into Wisdom. Purge temporary scripts (Scratch) and return a pristine environment to the Sovereign.

## Physical Enforcement
ミッションの終了時、AIエージェントは必ず以下のコマンドを実行して、物理的な環境を清算しなければならない。

- **Command**: `npx tsx scripts/mission_controller.ts finish <MISSION_ID>`
- **Validation**:
  - `scratch/` ディレクトリの自動清算（Purge）。
  - `active/archive/missions/` へのミッションフォルダの移動。
  - ステータスを `completed` に設定。

---
*Status: Mandated by GEMINI.md*
