---
title: 'PiBot 選択的採択計画 (PB-00〜06)'
kind: plan
status: active
last_updated: 2026-11-22
tags: [plan, pibot, adoption, approval, policy, workflow, ux, mission]
---

# PiBot 選択的採択計画 (PB-00〜06)

> **作成日**: 2026-11-22
> **分析対象**: [w01fb0ss/PiBot](https://github.com/w01fb0ss/PiBot)（調査 clone: `active/shared/tmp/pibot-analysis/PiBot`、公開 tip 付近 `c923b02` / v0.0.3）
> **Kyberion 前提 tip**: `origin/main`（同期時点）+ [PR #1563](https://github.com/famaoai-creator/kyberion/pull/1563)（Owner Grant continuity / scoped mission）を rebase した枝
> **実装枝**: `fix/scoped-mission-approval-pibot-20261122`（#1563 に PB を載せる）
> **位置づけ**: OpenClaw / Hermes / claw-empire と同型の「外部分析 → 選択的取り込み」。統治の芯（Mission / WorkItem / Lease / approval-store / tenant・tier）は Kyberion のまま、人間向けカードと Policy Category 行列を載せる。
> **概念正本**: [pibot-absorption-model](../../../knowledge/product/architecture/pibot-absorption-model.md)（`policy-category` / `workflow-disposition`）
> **分析**: [pibot-analysis](../../../knowledge/public/external-wisdom/pibot-analysis.md)

## 0. origin/main 更新後の前提（1608c806e）

採択は次を壊さない・重複実装しない。

| 領域                                                                                 | 現状（main）                                                                   | 採択への含意                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| WorkItem / Mission                                                                   | Concept Model v2: Mission は WorkItem の実行様式。子 WorkItem が lease         | PiBot step = 子 WorkItem。群 UI は作らない                             |
| Mission readiness                                                                    | preview JSON、queue dispatch、Surface 再試行で同一 Mission / issuance          | Plan card の Start は既存 admission / gate に載せる                    |
| Alignment                                                                            | `ALIGNMENT_APPROVED` + approval-store + brief hash                             | Plan card は Interaction Packet 投影。正本は store                     |
| Approval UX                                                                          | `decisionCard` / presented digest / needs-you / Concierge                      | Why + 3 ボタンは **既存カード契約の Concierge 収束**（新スタック禁止） |
| Grant                                                                                | Grant = principal × scope × operation（移行中）                                | Policy Category は Grant の前段分類。置き換えない                      |
| Approval continuity ([#1563](https://github.com/famaoai-creator/kyberion/pull/1563)) | Owner が terminal / Concierge で同一承認；CLI が Grant resume；非 Owner は 403 | Always ≠ Grant resume。Owner カードは Allow once のみ                  |
| Surfaces                                                                             | Concierge 中心、Chronos は `/ops` へ集約                                       | CEO は要約、詳細は Concierge `/ops`                                    |
| Factory / calendar 等                                                                | 同時期の別 PR                                                                  | 本計画の範囲外                                                         |

### 0.1 P0 向け現状棚卸し（`1608c806e`）

根拠: [approval UX inventory](4e0d82f4-922b-4cac-aeee-684627b2553d)。

既にあるもの（再利用する）:

| 部品                     | 場所                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Presented digest 束縛    | `libs/core/governance/approval-presentation.ts`                                                                                 |
| Decision card + Why 展開 | `decision-card.ts` / `approval-decision-card.ts`（`renderDecisionCardExplanation`、action `approve\|changes\|reject\|explain`） |
| Chat/surface 4 ボタン    | `libs/core/surface/surface-approval-ui.ts` `buildDecisionCardActions`                                                           |
| Plain-language brief     | `libs/core/surface/decision-brief.ts` + Concierge `decision-brief.tsx`                                                          |
| Concierge Needs You      | `needs-you-card.tsx` + `libs/core/surface/needs-you.ts`（現状 **approve / reject / later**）                                    |
| Store 決定 API           | `approval-store.ts`（settle は **`approved\|rejected` のみ**；`changeRequest` は reject 付帯）                                  |
| Plan preview（ops）      | `MissionPlanPanel.tsx` + `/api/ops/plan-preview`（会話内 Plan card ではない）                                                   |
| Interaction packet       | `libs/core/contracts/operator-interaction-packet.ts`（`execution-preview` 形あり）                                              |

ギャップ（PB-01〜03 が埋める）:

| P0               | ギャップ                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Approval Why + 3 | Why と chat 4 ボタンはある。Concierge は 2+later。Store settle は二値。**Allow once / Always(+scope)** が一次アクションとして無い |
| Plan card        | plan-preview は `/ops` パネル。**会話に束ねた Plan card**（Start/Modify）が無い                                                   |
| Disposition 4    | **カードとして不在**。失敗 Needs You は `later` のみ。collaboration の retry は nav kind                                          |

## 1. 項目一覧

| ID    | 内容                                                                               | 優先度 | 規模 | 状況                                              |
| ----- | ---------------------------------------------------------------------------------- | ------ | ---- | ------------------------------------------------- |
| PB-00 | 分析・吸収モデル・本計画・concept-registry / GLOSSARY 登録                         | P0     | S    | **本変更で完了**                                  |
| PB-01 | Approval card: Why（reason code）+ Deny / Allow once / Always（scope 明示）+ Inbox | P0     | M    | **実装**                                          |
| PB-02 | Plan Interaction Card（依存レイヤ・担当・成果物・見積・Start/Modify）              | P0     | M    | **実装**                                          |
| PB-03 | Workflow Disposition 4 アクション（retry / skip / reassign / accept）              | P0     | M    | **実装**                                          |
| PB-04 | Policy Category 宣言 + evaluate + probe matrix ゲート                              | P1     | L    | **実装（行列 + evaluator；manifest 全量は段階）** |
| PB-05 | Changes / Tasks 要約パネル（Concierge `/ops`）                                     | P1     | M    | **実装（read-model + Disclosure）**               |
| PB-06 | Bounded verdict repair（fix/recheck append、replan ≤ 2）                           | P2     | M    | **実装（API；dispatch フックはフォロー）**        |

## 2. 詳細

### PB-00: 文書と概念登録

- [pibot-analysis](../../../knowledge/public/external-wisdom/pibot-analysis.md)
- [pibot-absorption-model](../../../knowledge/product/architecture/pibot-absorption-model.md)
- concept-registry: `policy-category`, `workflow-disposition`
- GLOSSARY 見出しを registry 定義と一致させる
- 本ファイルを 2026-11 索引に載せる

### PB-01: Approval card UX

**PiBot**: チャット内カード +「Why am I asked?」+ Deny / Allow this time / Always allow（scope 表示）+ Inbox 件数。

**Kyberion 実装方針**（並行カードを新設しない）:

1. Concierge `needs-you-card` を `decision-brief` + `surface-approval-ui` / `approval-decision-card` の契約に収束させる（chat 側の Why / explain を Concierge でも同じ語彙で出す）。
2. 一次アクションを **Deny / Allow once / Always（scope 明示）** に揃える。既存の `changes` / `explain` は二次（Why 展開・差し戻し）として残してよい。
3. Store settle が二値の間は: Allow once → `approved`；Deny / changes → `rejected`（+ `changeRequest`）；Always → `approved` **かつ** task/standing Grant 発行（既存 grant-store）。Never / protected / paid / send_out は Always でも潰さない。
4. presented digest が Why 文面とボタン集合を束ねるテスト。Surface のみの決定は拒否されたまま。

紐付け: [approval-gate-design](../../../knowledge/product/governance/approval-gate-design.md)、[ceo-ux](../../../knowledge/product/architecture/ceo-ux.md) §5.2 / §7。

### PB-02: Plan Interaction Card

**PiBot**: 依存レイヤ表示、owner、deliverables、acceptance、コスト見積、Start / Modify。

**Kyberion 実装方針**:

1. 既存 `/api/ops/plan-preview` + `MissionPlanPanel` の read-model を、Operator Interaction Packet（`execution-preview`）として **会話 / Needs You にも束ねる**（ops 専用のままにしない）。
2. Start = 既存 approval-store 決定 → gate-pass / admission。Modify = `changeRequest` 相当 → brief 再ハッシュ（旧承認は再利用しない）。
3. DAG レイヤは `depends_on` から決定的に計算（PiBot `GroupPlanCard` の layers と同型）。
4. 受入: planned Mission でカード Start 後にだけ active 化する e2e。ブラウザが `mission_controller start` を直接呼ばない。

紐付け: [alignment.md](../../../knowledge/product/governance/phases/alignment.md)、mission readiness / queue。

### PB-03: Workflow Disposition

**PiBot**: blocked step で retry / skip / reassign / accept。

**Kyberion 実装方針**（greenfield・Needs You 拡張）:

1. 子 WorkItem が acceptance/execution 失敗で blocked のとき、Needs You の failure 経路を `later` のみから **retry / skip / reassign / accept** に拡張（collaboration board の retry nav とは別契約）。
2. 永続化は WorkItem review / recovery API（または専用 approval kind）。UI state alone は不可。approval-store の二値 settle に無理に押し込めない。
3. skip が verification step のとき、下流依存の扱いを契約で明示（PiBot の verdict skip 停止条件を参考）。
4. 受入: 4 アクションの語彙テスト + 不正 action 拒否。

### PB-04: Policy Category 行列

**PiBot**: `CategorySchema` × never/ask/always × 理由コード。Kyberion では `pnpm exec vitest run libs/core/governance/policy-category-matrix.test.ts` が期待値の TSV と照合する。

**Kyberion 実装方針**:

1. Actuator op カタログに `policy_category`（および任意の effect class）を宣言。
2. 共有 evaluator: facts → reason code → allow/ask/deny。ask は approval-store へ。
3. `tools` 相当の expected 表と `pnpm check` ゲート（実ネット・実ユーザー dir は使わない）。
4. Grant / assurance / SoD / dual-key の後段はそのまま。
5. 受入: darwin/linux/win32 相当の合成 fixtures で代表セルが固定。isolation 不可なら always 禁止。

紐付け: [grant-capability-policy](../../../knowledge/product/governance/grant-capability-policy.json)、egress / secure-io。

### PB-05: Changes / Tasks 要約

**PiBot**: Changes（This turn / Uncommitted / Diff）、Tasks（主/子・usage・plan history）。

**Kyberion 実装方針**:

1. Concierge `/ops` の mission detail に「このターンの成果物 / 未コミット差分要約 / 子 WorkItem ツリー」を投影。
2. CEO / Front Desk には件数と次アクションのみ。
3. 受入: mission evidence と worktree diff の read-model テスト。生ログの全面露出はしない。

### PB-06: Bounded verdict repair

**PiBot**: unresolved fail verdict → repair plan（fix + recheck）、replan ≤ 2、recheck skip で停止。

**Kyberion 実装方針**:

1. dynamic / mission 実行で verification fail 時、coordinator（mission owner）が子 WorkItem を append。
2. 上限 2。limit / pause / round と衝突したら明示 stop reason。
3. 受入: 3 回目 append が拒否されるテスト。静的 process template は勝手に書き換えない。

## 3. 推奨実装順

```text
PB-00 (本変更)
 → PB-01 Approval Why + 3ボタン
 → PB-02 Plan Interaction Card
 → PB-03 Disposition 4アクション
 → PB-04 Policy Category + probe matrix
 → PB-05 Changes/Tasks（/ops）
 → PB-06 Verdict repair
```

## 4. 非目標

- PiBot / pi ランタイムの移植
- 群チャット製品化
- YOLO 企業既定
- Surface を承認正本化
- claw-empire 系の Pixi オフィス再実施

## 5. 完了の定義（計画全体）

- PB-00 が main に入り、concept-registry ゲートが緑
- PB-01〜03 が Concierge または chat bridge で dog-food 可能
- PB-04 が CI で行列回帰
- PB-05〜06 は利用実績または明示的 defer 記録
