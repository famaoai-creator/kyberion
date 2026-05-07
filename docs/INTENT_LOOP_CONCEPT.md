---
title: 意図ループ — Kyberion 中核コンセプト
category: Concept
tags: [concept, intent-loop, governance, decision-support, agi]
importance: 10
author: famao
last_updated: 2026-04-20
---

# 意図ループ — Kyberion 中核コンセプト

Kyberion が解く本質問題を、層構造ではなく **ループ** として定義し直す文書。
実装の詳細は可換だが、このループが閉じ続けることは不可換。

---

## 1. 前提

- AGI / ASI が近づきつつある。推論能力は年単位で上がり続け、*どの CLI / モデル* が担うかは揺れる。
- 指示は常に曖昧で届く。CEO は全体感を重視し、細部は「成果が出るなら任せたい」立場。
- したがって Kyberion が保証すべきは「曖昧な入力を、意図を失わず、成果まで運ぶ」こと。
- この保証は *推論モデルの賢さ* に依存させない。**仕組みで担保する**。

## 2. 意図ループ

```
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   ① 受信 ── ② 明確化 ── ③ 保管 ── ④ 実行 ── ⑤ 検証 ── ⑥ 学習
  │                                                          │
  └──────────────────────────────────────────────────────────┘
             ↑                                     ↓
        次の受信は既に 保管済み意図 と 過去学習 を参照する
```

| 段 | 担うこと | 失敗モード |
|---|---|---|
| **① 受信** | 曖昧な自然言語 / 作業依頼を取り込む | 文字通り解釈しすぎる / 重要度を見誤る |
| **② 明確化** | 複数解釈のうち必要なものだけ確認する | 聞きすぎて進まない / 聞かずに暴走する |
| **③ 保管** | 確定した意図を構造化して保持する | どこにあるか分からなくなる / 途中で変質する |
| **④ 実行** | 意図に沿って actuator / agent を動かす | 途中の手続きで意図がズレる / 境界を越える |
| **⑤ 検証** | 成果が意図に合致しているか判定する | 表面的な完了だけを見て合致判定を省く |
| **⑥ 学習** | 意図・実行・成果の差分を知識へ還元する | 溜まるだけで参照されない / 誤学習が混ざる |

**ループ閉包の原則**：①〜⑥ のどこかで意図が欠落・変質したら、その時点で検知してループを前段に戻す。成果物があっても意図合致が取れていない出力は「完了」と呼ばない。

## 3. 現状の保有機構マッピング

origin/main と未 push ローカルの両系統は、このループの異なる段を担っている。**両者は補完関係**であり、合流すれば初めてループが閉じる。

| 段 | origin/main（統治基盤） | ローカル（判断支援） |
|---|---|---|
| ① 受信 | intent-classifier-routing / archetype 検出 | USE_CASES.md / CEO_SCENARIOS.md（入力空間の具体化） |
| ② 明確化 | mission classification / workflow catalog | hypothesis-tree / counterfactual / intuition-capture |
| ③ 保管 | mission-state / team blueprint-ledger / execution-receipt | negotiation-state / relationship-graph / heuristic-entry / dissent-log |
| ④ 実行 | delegation preflight / path-scope / team composition / voice・video stack | nemawashi orchestrator / rehearsal / decision-ops |
| ⑤ 検証 | review gate registry / golden scenario evaluator / execution-receipt validation | (薄い — 追加必要) |
| ⑥ 学習 | hardening-backlog / model-harness adaptation | intuition-capture → heuristic accrual（feedback 欠） |

**ギャップ**：⑤ で判断支援側が薄い、⑥ で heuristic の検証ループが閉じていない、②③ で両側の成果物が *同じループの同じ段* を別名で実装している箇所がある（要統合）。

## 4. INTP 補完の位置づけ

利用者（CEO）は全体感を起点に動く。細部担保を仕組みに委ねる。システム側は以下を自動で効かせる：

- **前に**：preflight（ADF / path-scope / delegation）
- **途中で**：review gate（段階ごと）/ execution-receipt（手続き証跡）
- **後に**：golden scenario による突き合わせ / orchestration evaluator
- **外側で**：hardening-backlog と model-harness adaptation による *仕組みそのもの* の更新

origin/main の 64 commits は **ほぼ全てこの「INTP が落としがちな細部を機構で担保する」方向の投資**。意図ループ思想と整合している。

## 5. 汎用骨格と文化 variant の分離

AGI/ASI 時代は推論層が可換。したがって Kyberion の schema / primitive は **文化非依存の骨格** に保つ。日本的管理術（nemawashi / honne-tatemae / 根回し順序）は **enum 値 / variant 実装 / 設定データ** として表現する。

具体例：

- schema 名 `nemawashi-protocol` → `stakeholder-consensus-protocol`（汎用）
- 実装 variant として `nemawashi`（日本式）/ `round-table`（欧米式）/ `pre-read-memo`（Amazon 式）等を並置
- `communication_style` enum に `honne` / `tatemae` を残すのは可（*データ* としての文化表現）

原則：**骨格は普遍・値は具体**。後者は自由に増減できる形で保つ。

## 6. 意図計装（Intent Delta）

現状の欠落機構。ミッション各段で「元指示の解釈」と「現在作業中の解釈」の差分を **観測可能にする**仕掛けを入れる。

- 各段階遷移時に `intent_snapshot` を生成（短い構造化要約）
- 段階間で `intent_delta` を自動算出（追加・削除・意味ズレ）
- 閾値超過時は review gate が blocking
- 完了時の intent_delta 累積はミッション品質指標として記録

これが入れば、意図ループの「閉じているか否か」を *事後ではなく実行中に* 検知できる。INTP 補完の最後のピース。

## 7. このループが不可換で、他は可換

- 推論モデル世代：可換（4.6 → 4.7 → X）
- CLI ホスト：可換（Claude Code / Codex / Gemini / 将来）
- Actuator 実装：可換（voice engine / browser backend）
- Schema 名称・variant：可換（文化適応）
- **意図ループ 6 段の存在と閉包**：**不可換**

この一点だけ守れば、他は AGI/ASI の進化に合わせて自由に組み替えられる。

---

## 参照

- `docs/archive/CONCEPT_INTEGRATION_BACKLOG.md` — 本概念に沿った実装タスク（アーカイブ済 — 主要項目は完了、残りは `docs/PRODUCTIZATION_ROADMAP.md` で追跡）
- `knowledge/public/architecture/kyberion-concept-map.md` — 既存コンセプト地図（要更新）
- `knowledge/public/architecture/hardening-backlog.md` — 実行細部の担保計画
- `knowledge/public/architecture/cli-harness-coordination-model.md` — 可換層の責務分割
