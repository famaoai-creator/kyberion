---
title: 意図の解決器の一本化計画（RoutingDecision と薄いアダプター）
kind: plan
status: completed
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

R1 の実施状況（2026-11-10）：写像は `libs/core/contracts/execution-shape.ts` に置き、intent-resolution の契約は畳む前の値を `execution_shape` として一緒に運びます。`resolution.shape` は保存せず、読み込み時に `execution_shape` から導きます（`execution-shape-single-source.test.ts` が検査）。charter は `allowed_execution_shapes` に改名し、古いキーは読み込み時に置き換えます。dot の提案の `work_shape` は、ハッシュで固定された行動台帳に保存されているため、台帳の移行と一緒に改名しました（R3 の dot 部分を参照）。

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

R3 の実施状況（2026-11-10）：完了条件は満たしました。`resolveIntentResolutionPacket` を使う本番のモジュールは解決器の入口 `libs/core/intent/intent-resolver-entry.ts` だけで、`tests/intent-resolver-entry-boundary.test.ts` がこれを固定します。入口は解決器だけを読み込む末端のモジュールで、packet を返す `resolveRoutingPacket`、組織の仕事の形も一緒に返す `resolveOrganizationWorkRouting`、入口ごとの事実から共通の compiler を通すかを決める `decideSurfaceCompilation` を持ちます。`routing-decision.ts` の `resolveRoutingDecision` はこの入口で読んだ packet から判断を作ります（contract を作る側が入口を使っても循環しないように分けました）。文面ではなく設定で形が決まっている依頼のために `routingDecisionForConfiguredShape` を加えました。

- Slack・音声・terminal：共通の `surface-runtime-orchestrator.ts` が入口で 1 回だけ `resolveRoutingDecision` を呼び、packet と判断を下流へ渡します（`compileUserIntentFlow` の `carriedRoutingDecision`）。音声（voice-hub）と terminal（terminal-hud の ask）もこの共通の経路を通ります。入力中のプレビューと失敗時の contract は入口を通して読みます。
- 入口ごとの特例：`surface-runtime-router.ts` の slack / presence / 80 文字の分岐は、`decideSurfaceCompilation` への入力の属性（受け取った agent、発話の長さ、複数行か、provider policy が委任を強制するか、mission team への引き継ぎか、受け手が決まっているか）に移しました。router は属性を報告するだけです。
- front desk：受付 pipeline の形は設定で決まっているので、`routingDecisionForConfiguredShape('pipeline')` の格上げの判定を読みます（挙動は同じ）。
- discussion：提案の文面を入口で読んで組織の仕事の形を決めます。確信度が 0.7 未満なら、これまでどおり `solution_project` です。
- 正規表現の分類：`classifyOrganizationWork` は `libs/core/intent/organization-work-classification.ts` に移し、組織の facade は入口の `resolveOrganizationWorkRouting` を使います（規則と確信度の計算は同じ）。`intent-compiler.ts` の keyword fallback（呼び出し側がカタログを渡したときだけ動き、本番の呼び出しはなかった）は削除しました。`intent-rules.yml` は読む処理がなかったため削除しました。移す前の出力は `resolver-adapter-characterization.test.ts`（+fixture）に記録し、移した後も同じです。
- `execution-brief.ts`：運ばれた判断があればその intent を使い、プロジェクト依頼の文面を読み直しません。
- 残り（R3 の時点）：dot。dot の提案の `work_shape` は、LLM が出す提案の schema、ハッシュで固定された行動台帳（提案全体のハッシュと、行と承認済みの提案の項目ごとの比較）、WorkItem の `requested_work_shape` に入っていたため、台帳の移行と一緒に行いました（次の段落）。

R3 の dot 部分の実施状況（2026-11-10）：dot の提案、行動台帳、WorkItem の項目名を `execution_shape` に揃え、dot を RoutingDecision を使うアダプターにしました。

- 台帳の版：行動台帳に版を持たせました（`libs/core/dot/dot-action-ledger-version.ts`）。新しく書く行は `schema_version: 2` を持ち、行と承認済みの提案の両方に `execution_shape` を書きます。`schema_version` のない古い行（版 1）は `work_shape` のまま読み、コードには `execution_shape` として見せます。ハッシュ（`semantic_hash`、共有の索引の `private_content_hash`、復旧の受領書の `action_hash`、判断の `original_proposal_hash`）と、行と承認済みの提案の項目ごとの比較は、書いたときの形のまま行います。古い提案で承認された行を状態の変更で書き直すときは提案の版（版 1）のまま書くので、比較は同じ版どうしになります。同じ operation key で古い版の操作をもう一度提案したときは、古い版の形でハッシュが一致すれば同じ操作として扱い、もとの承認を使い続けます。版が混ざった行（版 1 の行に `execution_shape`、版 2 の行に `work_shape` の提案など）と未知の版は読み込みで拒否します。検査は `dot-action-ledger-version.test.ts` です（古い台帳の検証、新しい行の検証、古い承認の後の状態の書き直し、両方の版での改ざんの検出）。
- 提案の schema と prompt：`dot_propose_action` の入力 schema、fenced block の説明、bounds の prompt は `execution_shape` を使います。`work_shape` と書いた提案は 1 リリースの間は別名として読み、両方あって値が違えば拒否します。
- WorkItem：dot の WorkItem は `requested_execution_shape` を持ちます。版 1 の行から作る WorkItem は、作成時の不変の内容を変えないよう `requested_work_shape` のままです。executor、mission の受け入れ、front desk、continuous operations の報告、daemon watchdog、concierge の mission alignment は、1 リリースの間は両方を読みます（`libs/core/dot/dot-requested-shape.ts`）。
- RoutingDecision：dot は発話を読まず、形は charter の `allowed_execution_shapes` で制限されています。そのため front desk と同じく、`routingDecisionForConfiguredShape` でその形の判断を作ります（`libs/core/dot/dot-routing-decision.ts`）。範囲の検査（dispatch、承認後の再検査、受け入れの照合、判断の効果前の検査で共通）はこの判断を結果として返し、executor はこの判断で実行の形を決めます。work-scope policy が別の形に変える場合は拒否し、dot は charter の範囲で提案し直します。今の policy ではどの形も変わらないので、挙動は同じです。判断そのものは WorkItem に載せていません。work-scope policy の版が変わると、復旧時に作り直す WorkItem の不変の内容と食い違うためです。
- 組織の `work_shape`（`libs/core/entity-scope.ts` の WorkItem の種類）は、D7 のとおり名前を変えていません。

## 完了の合図

concept-registry から `execution-shape`、`work-shape`、`routing-decision` の `lifecycle` を外します。2026-11-10 に外しました（`scripts/check_concept_registry.ts` が通ることを確認）。
