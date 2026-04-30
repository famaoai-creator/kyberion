---
title: Decision-Support Design Rationale
category: Architecture
tags: [decision-support, design-rationale, intent-loop, judgment]
importance: 8
author: famao
last_updated: 2026-04-20
---

# Decision-Support Design Rationale

CEO 業務代替という Kyberion の目的に対して、なぜ判断支援レイヤが必要で、どの理論・慣行を参照し、Kyberion の既存契約にどう接続したかを記録する。voice / hyperframes の `absorption-plan` 形式は OSS 取り込み用途のため、本作業には適さず **design-rationale** 形式を採用する（P3-1）。

## 1. 背景

CEO の実業務は「構造化された手順を踏む」タスクと「判断そのもの」が不可分に混在する。
ハードスキル系のタスク（契約レビュー、資料作成、予実管理）は既存 actuator で自動化できるが、意思決定 — 特に *曖昧な選択肢の中から絞り込む* / *反対される前に地固めする* / *相手を想像してリハーサルする* — は既存 Kyberion 層では保管・再現できなかった。

ここを仕組み化しない限り「CEO 業務の完全代替」ビジョンは達成できない。

## 2. 参照した枠組み

外部 OSS の移植ではない。管理学・行動経済学・日本的経営慣行から骨格を抽出した。

| 領域 | 参照 | Kyberion プロトコル化 |
|---|---|---|
| 発散・収束 | 仮説思考、仮説ドリブン、Six Thinking Hats | `hypothesis-tree-protocol.md`（3+ persona による発散 → 批評 → dissent 保持） |
| 反事実 | Kahneman/Tversky の counterfactual simulation | `counterfactual-simulation-protocol.md`（short-horizon simulation、cost-cap） |
| 直観・ヒューリスティクス | Klein の Recognition-Primed Decision / 野中 SECI | `intuition-capture-protocol.md`（3 問で抽出 → heuristic-entry） |
| 事前合意 | 日本企業の根回し / 米 Amazon 6-pager / 欧米 round-table | `stakeholder-consensus-protocol.md`（Power/Interest × variant） |
| 交渉 | Harvard PON（BATNA / ZOPA） | `negotiation-protocol.md`（negotiation-state schema） |
| 練習 | 役者の roleplay / スポーツ心理学のメンタルリハ | `rehearsal-protocol.md`（synthetic counterparty persona） |
| 会議支援 | 弁論大会 / 営業コーチング | `real-time-coaching-protocol.md`（live hint injection） |
| ステークホルダー記憶 | CRM の construct を拡張 | `relationship-graph-protocol.md`（trust_level / honne-tatemae / ng_topics） |

## 3. 意図ループへの配置

`docs/INTENT_LOOP_CONCEPT.md` の 6 段に対応させる。判断支援は主に ②明確化 / ③保管 / ④実行 を担う。

| 段 | 担当プロトコル |
|---|---|
| ② 明確化 | hypothesis-tree（視点分岐）/ counterfactual（what-if 分岐）/ intuition-capture（直観抽出） |
| ③ 保管 | negotiation-state / relationship-graph / heuristic-entry / dissent-log |
| ④ 実行 | stakeholder-consensus orchestrator / rehearsal / real-time-coaching / decision-ops |
| ⑤ 検証 | STAKEHOLDER_ALIGNMENT / DISSENT_RESOLUTION / REHEARSAL_READINESS / INTENT_DRIFT gates |
| ⑥ 学習 | heuristic feedback loop（P2-5 実装予定） |

## 4. Kyberion 契約との対応

| 判断支援要素 | Kyberion 契約 |
|---|---|
| プロトコル | `knowledge/public/orchestration/*-protocol.md` |
| スキーマ | `schemas/{dissent-log,heuristic-entry,negotiation-state,relationship-node}.schema.json` |
| パイプライン | `pipelines/{hypothesis-tree,counterfactual-branch,negotiation-rehearsal,stakeholder-consensus-orchestrator}.json`（canonical JSON ADF） |
| Ops | `libs/actuators/wisdom-actuator/src/decision-ops.ts`（実装 5 + stub 8） |
| ミッション分類 | `mission_class: decision_support`（P1-1） |
| ワークフロー | `decision-support-exploratory` template（P1-2） |
| レビューゲート | `STAKEHOLDER_ALIGNMENT` / `DISSENT_RESOLUTION` / `REHEARSAL_READINESS` / `INTENT_DRIFT`（P1-3） |
| Path scope | `confidential_heuristics` / `confidential_relationships`（P1-4） |
| チームロール | `devils_advocate` / `counterparty_persona` / `facilitator` / `relationship_curator`（P1-5） |
| シナリオ | 4 件（P1-6） |

## 5. AGI/ASI 時代を見据えた可換性

推論層（モデル・CLI ホスト）は可換。判断支援の **骨格** は普遍、**実装の具体** は可換、**文化表現の値** は具体。

- 骨格：Power/Interest × 1on1 × dissent 吸収 × readiness 数値化
- 可換：stub 8 ops の LLM 実装手段（Claude SDK / ホスト CLI 委譲 / ローカルモデル）
- 具体：variant enum 値（`nemawashi` / `round_table` / `pre_read_memo` / `bilateral_memo`）

AGI が実現しても骨格は同じ。「誰にいつ何を聞くか」「反対を早期に吸収する」「意図ループが閉じているか」は *人間社会の構造* に依存しており、モデル世代によらない。

## 6. 残課題

- **P2-1**：stub ops の実装（ホスト CLI 経由推論）
- **P2-2**：voice engine registry 経由の rehearsal/1on1 実音声化
- **P2-3**：relationship-graph への presence/voice hooks
- **P2-5**：heuristic feedback loop（直観の事後検証）
- **P1-7 残件**：intent_snapshot の lifecycle emission

これらは CONCEPT_INTEGRATION_BACKLOG.md を参照。

## 7. 倫理的境界

判断支援は *情報整理* であり *情報操作* ではない。反対意見を隠蔽したり、同意のみを抽出したり、相手を不利な選択へ誘導する目的で使ってはならない。全プロトコルは「提案が通らなかった場合は提案を再設計する」方向を正とする。

---

## 参照

- [docs/INTENT_LOOP_CONCEPT.md](docs/INTENT_LOOP_CONCEPT.md) — 6 段の意図ループ
- [docs/CONCEPT_INTEGRATION_BACKLOG.md](docs/CONCEPT_INTEGRATION_BACKLOG.md) — タスク管理
- [knowledge/public/orchestration/](knowledge/public/orchestration) — プロトコル群
- [knowledge/public/architecture/cli-harness-coordination-model.md](knowledge/public/architecture/cli-harness-coordination-model.md) — 可換層の責務分割
- [knowledge/public/architecture/hardening-backlog.md](knowledge/public/architecture/hardening-backlog.md) — 細部担保計画
