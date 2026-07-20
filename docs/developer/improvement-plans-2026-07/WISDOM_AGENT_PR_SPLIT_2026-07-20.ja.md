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

## 2026-07-20 時点の実装状況と積み残し

PR #603 では、PR 1〜6 のうち次の基盤を実装済みである。

- Wisdom の direct action / pipeline / reconcile 契約、typed dispatcher、context propagation、unknown op / kind mismatch / nested failure の境界。
- Wisdom と Agent / Orchestrator / Meeting / Modeling / Media / Voice / Approval / Deployment の ownership forwarding。
- `AgentExecutionPort`、Orchestrator の task-plan coordination、normalized receipt、retry / idempotency metadata。
- scoped knowledge search、署名付き KKP、origin scope 検証、promotion approval、deprecated alias の receipt 記録。
- schema、manifest、registry、discovery、ownership matrix、Capability Guide の同期検査。
- pipeline 実行ごとの `ActuatorForwardingPort` 分離。グローバル mutable port による concurrent run の相互汚染を防止した。

完了までの積み残しは次のとおりである。

| 優先度 | 積み残し                                   | 完了条件 / 次の扱い                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | PR の CI を green にする                   | `check:deprecated-wisdom-ops` が検出する既存 pipeline の `wisdom:transcribe_audio` / `wisdom:extract_requirements` を、PR の tracked pipeline 上で voice / modeling の canonical opへ移行する。ローカルでユーザーが削除中の pipeline 変更は勝手に staged しない。 |
| P0     | push 後の全 CI と clean catalog の再確認   | lint、test、Cross-OS、security、catalog、contract、op-registry、forwarder を再実行する。未追跡 knowledge asset がある現ワークツリーでは catalog check が不安定になるため、commit 内容とローカル状態を分けて記録する。                                             |
| P1     | `decision-ops.ts` の domain 分割を完了する | pure move と behavior change を分け、knowledge / decision-support / reasoning / compatibility の各 module と registry を一つの source of truth にする。                                                                                                           |
| P1     | side-effect retry の全 actuator 統一       | append、approval、reminder、deployment、Agent spawn を自動 retry せず、idempotency key と receipt の retry history を contract test で固定する。                                                                                                                  |
| P1     | Agent runtime の live contract smoke       | external Agent runtime、meeting bridge、deployment adapter が利用可能な環境で、delegation / A2A / runtime receipt が reasoning receipt と混同されないことを確認する。未接続環境では現在の mock / fixture test を証跡とする。                                      |
| P2     | compatibility alias の段階的縮退           | 少なくとも一つの minor version 期間 alias を維持し、deprecated usage がゼロになった後に削除判断を行う。グローバル forwarding fallback は scoped port 利用へ段階的に縮退する。                                                                                     |
| P2     | UI/UX の実ランタイム表示                   | Capability Guide の canonical owner 表示は追加済みだが、operator UI の receipt、forwarded target、deprecated alias、retry status 表示は未実装。ユーザーが実行結果から owner と再試行可否を判断できる UI contract を次 PR で定義する。                             |
| P2     | generated types の完全な生成経路           | schema から生成される型、registry、manifest、discovery、docs examples の drift を CI で一貫して検出し、生成型を手編集しない運用を完成させる。                                                                                                                     |

### 現在の CI / worktree に関する注意

PR #603 の CI は tracked な `pipelines/meeting-minutes-generator.json` に残る deprecated Wisdom forwarder を検出する。現在のローカル worktree ではこのファイルがユーザー変更として削除状態だが、その削除は本 PR の修正として commit していない。したがって、CI を green にする canonical migration は、tracked pipeline の意図を保ったまま別の明示的変更として扱う必要がある。

以下のローカル変更はこの計画の成果物ではなく、引き続き commit へ含めない。

- `libs/core/src/types/meeting-operations-profile.ts`
- `pipelines/meeting-minutes-generator.json`
- `pipelines/notion-oauth-test.json`
- `evidence/` および `knowledge/product/evolution/` の未追跡ファイル
- `knowledge/public/design-patterns/media-templates/document-composition-presets/kyberion-overview-20pages.json`
