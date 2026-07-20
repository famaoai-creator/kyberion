# Wisdom / Agent 境界改善 PR 分割計画

この計画は、`wisdom-actuator` の契約変更を一つの巨大PRへ戻さず、実行境界ごとにレビュー可能な単位へ分けるための引き継ぎ基準である。

## PR 1 — Contract baseline

対象: PR #603

- direct action、pipeline、reconcile の公開契約
- typed dispatcher と pipeline context propagation
- unknown op / kind mismatch / nested failure
- `AgentExecutionPort`
- normalized Wisdom receipt と retry分類
- ownership matrix、schema、manifest、generated catalog

検証: Wisdom / Agent / Orchestrator / Meeting tests、core port tests、typecheck、build、catalog checks。

## PR 2 — Canonical migration

対象: PR #603 の後続コミット群、または専用の `feat/wisdom-canonical-migration` branch。

- `a2a_fanout` → `perspective_fanout`
- `a2a_roleplay` → `counterparty_roleplay`
- `cross_critique` → `typed_cross_critique`
- `tool_use` → `propose_tool_calls`
- `react_loop` → `reasoning_loop`
- pipeline catalog の deprecated利用をゼロにする
- `check:deprecated-wisdom-ops --fail` をCI gateにする

aliasは少なくとも一つのminor version期間維持し、receiptへcanonical opとdeprecated aliasを記録する。

## PR 3 — Pure domain extraction

- `decision-ops.ts` から knowledge、decision-support、reasoning、compatibility を実ロジック単位で移動
- registryをdomain moduleの単一sourceにする
- pure moveとbehavior changeを同じcommitへ混ぜない

検証: 既存decision-ops tests、各domainのfocused tests、operation registry drift check。

## PR 4 — Cross-actuator adapters

- File / Terminal / Media / Voice / Meeting / Approval / Deployment / Modelingのtyped adapter
- Wisdomはportのみ依存し、各actuator packageをimportしない
- forwarded receiptにtarget actuator、target op、idempotency key、statusを記録

## PR 5 — Orchestrator / Agent execution split

- DAG validation、runnable-task decision、retry/stop、execution ledgerをOrchestratorへ移管
- Agentはenvelope受領、runtime解決、実行、receipt返却だけを担当
- core `task-executor` はport facadeまたはdeprecated compatibility入口へ縮退

## PR 6 — Knowledge and side-effect hardening

- scoped hybrid searchのscope-first enforcement
- KKP signature/trust verification
- promotion approval
- non-idempotent side-effect deduplication
- retry metadataの全actuator receipt統一

各PRは、前PRのheadをbaseにする。無関係なworktree変更、生成artifact、live runtime証跡はcommitへ含めない。
