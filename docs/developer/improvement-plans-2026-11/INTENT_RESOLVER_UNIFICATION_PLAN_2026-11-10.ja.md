---
title: 意図の解決器の一本化計画（RoutingDecision と薄いアダプター）
kind: plan
status: planned
last_updated: 2026-11-10
tags: [plan, concepts, intent, routing, execution-shape, work-scope-policy, surfaces]
importance: 8
---

# 意図の解決器の一本化計画

決定記録 [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) の D7 を実装する計画です。4 本の移行計画の 3 本目です。RoutingDecision の権限レベルは [スコープ・ID・権限の統合](./SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md) の Grant に乗ります。

## 現状（2026-11-10 の調査）

- 発話から実行方法を決める仕組みが約 13 か所あります。中核の `resolveIntentResolutionPacket`（`libs/core/intent/intent-resolution.ts`）を 9 つがそれぞれ呼び、1 回の依頼で何度も解決し直しています。
- 実行の形を表す語彙が 5 系統あり、食い違っています。
  - `ExecutionShape`：7 値（`libs/core/contracts/execution-shape.ts`）
  - `routeFamily`：5 値（`router-contract.ts`）
  - `IntentResolutionShape`：4 値（`intent-resolution-contract.ts`。`pipeline` を `task_session` に畳んでしまう）
  - dot の `work_shape`：4 値（`dot-proposals.ts`）
  - 組織の `work_shape`：6 値
- 「mission に格上げするか」の判定が 4 か所にあります：`intent-routing-decision.ts`、`intent-delivery-decision.ts`、`intent-policy.json` の durable-shapes、`work-scope-policy.json` の catalog-floor。
- `standard-intents.json` は、176 件の intent のうち 10 件で `execution_shape` と `resolution.shape` が食い違っています。
- front desk（`front-desk-execution.ts`）は `pipeline` を、discussion（`discussion-outcomes.ts`）は `solution_project` を固定で書いています。

## 段階

### R1 — 語彙の統一（挙動は変えない）

- `standard-intents.json` の `resolution.shape` を削除し、`execution_shape` だけにする。食い違っている 10 件は 1 件ずつ決める。2 つの値が一致しているかを gate で検査し、検査が通ったら削除する。
- `IntentResolutionShape` と `routeFamily` を、`ExecutionShape` からの名前付きの写像にする。`pipeline` を `task_session` に畳む処理は廃止する。
- dot の `work_shape` / `allowed_work_shapes` を `execution_shape` / `allowed_execution_shapes` に改名する（charter の schema は互換の別名を 1 リリース残す）。

R1 の実施状況（2026-11-10）：写像は `libs/core/contracts/execution-shape.ts` に置き、intent-resolution の契約は畳む前の値を `execution_shape` として一緒に運びます。`resolution.shape` は保存せず、読み込み時に `execution_shape` から導きます（`execution-shape-single-source.test.ts` が検査）。charter は `allowed_execution_shapes` に改名し、古いキーは読み込み時に置き換えます。dot の提案の `work_shape` は、ハッシュで固定された行動台帳に保存されているため、台帳の移行と一緒に改名します（未実施）。

### R2 — RoutingDecision と 1 回だけの解決

- `RoutingDecision`（intent_id、execution_shape、authority_level、delivery_mode、promotion）を `libs/core/contracts/` に定義する。
- 解決器はこれを 1 回だけ出し、入口から下流へ引き渡す。下流は発話を読み直さない（`intent-resolution.ts` の GAP1 を解消する）。
- 格上げの判定を `work-scope-policy.json` だけに置き、他の 3 か所はその結果を読む。

R2 の実施状況（2026-11-10）：`RoutingDecision` は `libs/core/contracts/routing-decision.ts` に置き、`libs/core/intent/routing-decision.ts` の `resolveRoutingDecision` が発話を 1 回だけ解決して packet と一緒に返します。`pnpm intent:run` はこれを入口で 1 回だけ呼び、`routing_decision` として下流へ運びます。Super-Nerve の実行経路（`compileIntent` の `routingDecision` 引数）は運ばれた判断を使い、発話を読み直しません（`scripts/run_intent.single-resolution.test.ts` が検査）。どの実行の形がそれだけで mission になるかは `work-scope-policy.json` の `catalog-floor` 規則だけが名指しし、`intent-routing-decision.ts`・`intent-delivery-decision.ts`・`intent-policy.json` の `durable-shapes`（`work_scope_promotion: true`）は `catalogShapePromotesToMission` でその判定を読みます。挙動は標準 intent 全件の特性化テスト（`promotion-judgment-characterization.test.ts`）で変更前と同じことを確かめています。残り：Slack などの入口（`surface-runtime-orchestrator.ts` ほか）と、`execution-brief.ts` がプロジェクト依頼の文面で公開層の解決をやり直す箇所は、R3 で入口のアダプターに寄せます。

### R3 — 入口のアダプター化

- Slack、音声、terminal、front desk、discussion、dot を、RoutingDecision を使うだけのアダプターにする。
- 入口ごとの特例（`surface-runtime-router.ts` の slack / presence / 80 文字の分岐）は、解決器への入力の属性に移す。
- 正規表現で独自に分類しているもの（`classifyOrganizationWork`、`intent-compiler.ts` の keyword fallback、`intent-rules.yml`）は、解決器に吸収するか削除する。
- 完了条件：`resolveIntentResolutionPacket` を呼ぶのは解決器の入口 1 か所だけ。境界テストで固定する。

## 完了の合図

concept-registry から `execution-shape`、`work-shape`、`routing-decision` の `lifecycle` を外します。
