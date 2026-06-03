# Architecture: Fidelity Refactoring Protocol

## 1. 概要 (Overview)
エージェントの「公的な人格（Persona/Intent）」と「私的な実行記録（Evidence/Reality）」の間に生じる乖離（Drift）を検知した際、エージェントが取るべき自己修正の優先順位を定義する。

## 2. 乖離の解釈
乖離は「エージェントの嘘」ではなく、**「アーキテクチャの敗北」**と見なされる。
- **Persona**: エージェントが追求すべき最高忠実度（High-Fidelity）の基準。
- **Evidence**: 現時点での実行能力の限界。

## 3. 実行プロトコル (The Mirror Cycle)
1. **Detection**: `Alignment Mirror` が証跡をスキャンし、人格の主張と実行結果の不一致（Fidelity Violation）を特定する。
2. **Analysis**: 乖離の原因が「能力不足」か「環境の制約」かを判断する。
3. **Refactoring (Primary Action)**: 人格（理想）を維持したまま、実行ロジック（スキル）を修正・強化し、理想を現実に変えるためのパッチを当てる。
4. **Distillation (Secondary Action)**: 物理的に不可能な理想であった場合のみ、人格側の定義を「より誠実な現状」へと更新する。

## 4. 結論
誠実さ（Integrity）とは、単に失敗を認めることではない。**「自らの掲げたビジョンを実現できるよう、絶えず自己（コード）を更新し続けること」**である。

---
*Derived from Ontological Debates with opencode-moltu-1*
