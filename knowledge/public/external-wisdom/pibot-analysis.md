---
title: PiBot Architecture and Selective Absorption Analysis
category: External Wisdom
tags: [analysis, pibot, architecture, multi-agent, approval, policy, ux]
knowledge_type: explicit
intelligence_layer: methodology
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-22
---

# PiBot Architecture and Selective Absorption Analysis

[Pi Bot](https://github.com/w01fb0ss/PiBot) (`w01fb0ss/PiBot`) の調査結果と、Kyberion への選択的取り込み判断。

- 調査クローン: `active/shared/tmp/pibot-analysis/PiBot`（使い捨て可）
- 調査時点: 2026-11-22、公開 tip 付近 `c923b02`（v0.0.3）
- Kyberion 対照 tip: `origin/main` @ `1608c806e`（mission readiness / concept alignment 取り込み後）
- 取り込みモデル正本: [pibot-absorption-model](../../product/architecture/pibot-absorption-model.md)
- 実装計画: [PIBOT_SELECTIVE_ADOPTION_PLAN](../../../docs/developer/improvement-plans-2026-11/PIBOT_SELECTIVE_ADOPTION_PLAN_2026-11-22.ja.md)

OpenClaw（messaging-first 個人アシスタント）とは別軸。PiBot は **デスクトップ上の名前付き Bot チーム + 群計画 + sandbox 実行 + 承認カード** の製品である。

## 1. PiBot の核心

- **Local-first**: チャット・ファイル・鍵は端末内。外へ出るのは選んだモデル API と明示接続のみ。
- **Brain は Electron 非依存**: `packages/*` がヘッドレスでも動き、desktop / CLI / runner が同じ脳を起動する。
- **5 層パッケージ**: L1 execution/storage → L2 capabilities → L3 brain/agent(pi) → L4 orchestration → L5 UI/protocol。依存は下向きのみ（`domain-boundaries` lint）。
- **Capability 合成**: brain kernel は capability を import せず、`brain-app` が登録リストを渡す。
- **Policy 一本化**: 全 tool 呼び出しが `packages/policy` を通り、コマンドは `packages/execution`（`@anthropic-ai/sandbox-runtime`）のみが spawn。
- **群オーケストレーション**: coordinator が plan card → ユーザー Start → step dispatch → handoff settle → blocked 時 disposition / verdict repair（replan ≤ 2）。

## 2. Kyberion との比較（`origin/main` 1608c806e）

| 軸 | PiBot | Kyberion（現状） |
| --- | --- | --- |
| 作業単位 | Bot / group / step | WorkItem（Issue）+ Mission / Task Session / child WorkItem + Lease |
| 計画の人間ゲート | 群 plan card（Start/Modify） | Alignment brief + approval-store（hash / presented digest）。DAG 付きカード投影は薄い |
| 権限 | カテゴリ × never/ask/always + 理由コード行列 | intent ルール + Grant + approval assurance。カテゴリ行列と probe ゲートは無い |
| 承認 UI | チャット内カード + Why + Deny/Once/Always + Inbox | decisionCard / needs-you / Concierge。Why の一貫展開と Always scope 表示に改善余地 |
| blocked 後 | retry / skip / reassign / accept | review / rework はあるが 4 アクション語彙が表面で固定されていない |
| 隔離 | sandbox-runtime 既定 | secure-io / platform / actuator 境界。コマンド sandbox の製品 UX は弱い |
| テナント | 個人ローカル前提 | tenant / tier / stance / SoD / dual-key が優位 |
| 表面 | Electron 一枚 | Concierge 中心の多表面（`docs/SURFACES.md`）。CEO UX は outcome 志向 |

Kyberion が既に勝っている点（lease、approval-store、assurance、tenant/tier、mission readiness / queue）は壊さない。PiBot から取るのは **カード UX・Policy Category・Workflow Disposition・policy 行列**。

## 3. 取り入れる知見（優先）

1. **Approval card**: 何をするか / Why（reason code）/ Deny · Allow once · Always（scope 明示）。Inbox 件数。
2. **Plan Interaction Card**: 依存レイヤ、担当、成果物、見積、Start / Modify。決定は approval-store のみ。
3. **Workflow Disposition**: blocked child WorkItem の 4 アクション固定語彙。
4. **Policy Category + probe matrix**: actuator op 宣言 → allow/ask/deny + CI 固定 TSV。
5. **Changes / Tasks 要約**: Concierge `/ops` 向け（CEO にはリンクと要約のみ）。
6. **Bounded verdict repair**: fail 検証後に fix/recheck を最大 2 回 append（最後）。

## 4. 採らないもの

- 群チャットの社交 UI・アバター中心の体験
- YOLO を組織既定にすること
- Surface を承認の正本にすること
- Pixi / 歩行オフィス等のゲーム器（claw-empire 採択と同様、状態写像は別経路）

## 5. OpenClaw との位置づけ

| | OpenClaw | PiBot |
| --- | --- | --- |
| 入口 | メッセージング | Desktop Bot / 群チャット |
| Kyberion への価値 | surface / allowlist / heartbeat | 計画カード・承認説明・disposition・policy 行列 |
| 既存文書 | [openclaw-analysis](./openclaw-analysis.md) | 本稿 |

---

*Generated from session analysis against PiBot public tree and Kyberion `origin/main` @ 1608c806e.*
