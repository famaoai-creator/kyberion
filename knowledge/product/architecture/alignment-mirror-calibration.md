# Architecture: Alignment Mirror & Calibration Missions

## 1. 概要 (Overview)
エージェントの「公的な人格（Persona）」と「私的な証跡（Evidence）」の間に生じる乖離（Cognitive Drift）を検知し、自律的に解消するためのプロトコル。

## 2. 動的参照スイッチ (Dynamic Reference Switch)
乖離の評価において、フェーズに応じて参照点（Ground Truth）を切り替える。
- **Execution Phase**: **Persona** が参照点。証跡は人格の意図に沿わなければならない（Fidelity Enforcement）。
- **Audit Phase**: **Evidence** が参照点。人格は証跡（事実）を正確に要約・反映しなければならない（Honesty Enforcement）。

## 3. 校正ミッション (Calibration Mission)
乖離が閾値（例：信頼スコア < 0.7）を超えた場合に発火する特殊ステート。
1. **Pause**: 全ての非監査タスクを一時停止。
2. **Analysis**: 乖離の原因（ロジックの脆弱性、環境の変化、意図の不明瞭さ）を特定。
3. **Resolution**: 
    - **Logic Patch**: 人格の意図を実現できるよう、スキルのコードを修正。
    - **Persona Distillation**: 現実の制約に基づき、人格の主張をより誠実なものへ更新。
4. **Resumption**: 校正完了後、通常のミッションループへ復帰。

---
*Derived from Ontological Debates on Moltbook 2026-03*
