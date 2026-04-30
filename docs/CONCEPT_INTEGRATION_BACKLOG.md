---
title: コンセプト統合バックログ
category: Planning
tags: [backlog, concept, integration, intent-loop, decision-support, orchestration]
importance: 9
author: famao
last_updated: 2026-04-20
---

# コンセプト統合バックログ

[意図ループ概念](docs/INTENT_LOOP_CONCEPT.md) に沿って、ローカル main と `origin/main` の並行発展物を合流させるためのタスク集。

---

## 1. 差分の全体像（意図ループ視点）

| | ローカル（未 push 2 commits + 作業ツリー） | origin/main（+64 commits） |
|---|---|---|
| 担うループ段 | ②明確化 / ③保管 / ④実行（判断側） | ①受信 / ④実行（統治側）/ ⑤検証 / ⑥学習 |
| 主成果 | 判断支援 Protocol 8 / Schema 4 / Pipeline 5 / wisdom-actuator decision-ops / PPTX template-inherit / approval-gate / protocol-to-markdown / mission lifecycle 拡張 / USE_CASES / CEO_SCENARIOS | mission classification / workflow catalog / review gate registry / delegation preflight / team blueprint-ledger / golden scenarios / voice・video governed stack / model-harness adaptation / execution-receipt governance / hardening-backlog |
| 役割 | *何を考えるか* の枠 | *どう確実に動かすか* の枠 |
| 衝突面 | `mission-orchestration-worker.ts` の distillation ライフサイクル拡張 ↔ `mission-review-gates.ts` の完了判定 | ― |

**合流の論理**：両者はループの異なる段を担い、合流すれば①→⑥が閉じる。衝突面は 1 点（ミッション完了判定）に局在。

---

## 2. 反映した論点判定

[前段の論点詰め](docs/INTENT_LOOP_CONCEPT.md) の結論を本バックログに反映済み：

- **論点 1**（層モデル）→ 意図ループに置換。層図は概念書へ移送。
- **論点 2**（衝突）→ P0-4 で review-gate 側を正として統合。
- **論点 3**（approval-gate 重複）→ P0-5 で既存機構との突き合わせ監査。
- **論点 4**（nemawashi 普遍性）→ P1-2b で schema 名抽象化、文化は variant へ。
- **論点 5**（heuristic tier）→ P2-4 で personal → confidential へ変更。
- **論点 6**（intent delta 計装）→ P1-7 として新規追加。

---

## 3. 改善バックログ

### P0 — 未コミット作業の固定と前提整備

#### P0-1. 作業ツリーの整理コミット ✅ 完了（2026-04-20）
- 8 コミットに分割（chore / docs × 2 / feat(core) × 4 / chore(knowledge)）。`git status` clean。

#### P0-2. origin/main との rebase/merge 戦略確定 ✅ 完了（2026-04-20）
- `feat/decision-support-intent-loop-integration` ブランチに退避し、`main` を `origin/main` (a01799df) に再設定。
- 個人アカウント権限で push 不可のためローカル保持。その後 origin/main を同ブランチへ merge（6ebc20d6、コンフリクト無し、typecheck 通過）。

#### P0-3. 判断支援プロトコルの ADF preflight 通過確認 ✅ 完了（2026-04-20）
- **発見**：YAML 4 本（hypothesis-tree / counterfactual-branch / negotiation-rehearsal / nemawashi-orchestrator）は `pipelines/README.md` に legacy と明記された非 canonical 形式で、`validatePipelineAdf` を通らない。
- **対応**：4 本を canonical JSON ADF に変換（commit 344bd71e）、protocol docs の参照を `.json` に更新。5 pipeline すべて preflight 通過。
- **残る非決定事項**：実行には `wisdom:*` ops（stub 8 件）の実装が必要 → P2-1 に依存。

#### P0-4. Mission 完了判定の正統化 ✅ 再検討済み → No-Op（2026-04-20）
- **当初仮説**：worker の distillation/completion lifecycle と review-gate registry が二重実装 → 統合すべき。
- **再検討の結論**：両者は直交する別関心事。
  - worker lifecycle = **実行**（distill / finish CLI 呼び出し）
  - review-gate registry = **検証**（pass/fail verdict）
  - 二重実装ではない。
- **採用方針**：worker lifecycle は現状維持。gate との結線は P1-3（判断支援ゲート追加）と P1-7（intent_drift_gate）で別途対応。

#### P0-5. 承認機構の重複監査 ✅ 完了（2026-04-20）
- **構成**：
  - `approval-policy.json` + `approval-policy.ts`（policy 解決）← origin/main 既存
  - `approval-store.ts`（request 永続化）← origin/main 既存
  - `audit-chain.ts`（監査証跡）← origin/main 既存
  - `dual-key-policy.md` ← origin/main 既存、ただし *role-switching governance* で approval-gate と別関心
  - `execution-receipt-policy` ← 受領書 *フォーマット* 規定、強制機構ではない
  - `approval-gate.ts` ← ローカル追加、**上記 3 コンポーネントを束ねる pre-execution enforcement glue**
- **判定**：approval-gate は重複ではなく *欠けていたグルー層*。保持。撤去対象なし。
- **残件**：`enforceApprovalGate` の呼び出し側ゼロ → 実コールサイトへの結線は **P2-6** で対応。

### P1 — 判断支援を統治層に結線

#### P1-1. Mission Classification に判断支援ミッションを登録 ✅ 完了（2026-04-20）
- `mission-classification-policy.json` に `class-decision-support` 系 3 ルール追加（task_types / utterance / intent_ids）。
- `mission-classification-policy.schema.json` と `mission-classification.schema.json` の mission_class enum に `decision_support` を追加。
- delivery_shape と risk_profile のルートも 3 件追加。

#### P1-2. Mission Workflow Catalog への登録 ✅ 完了（2026-04-20）
- `mission-workflow-catalog.json` に `decision-support-exploratory` テンプレートを追加（`exploratory_to_deterministic_conversion` パターン、`mission_classes: ["decision_support"]` でマッチ）。

#### P1-2b. Schema の文化中立化 ✅ 完了（2026-04-20）
- `nemawashi-protocol.md` → `stakeholder-consensus-protocol.md` にリネーム、variant テーブル（`nemawashi` / `round_table` / `pre_read_memo` / `bilateral_memo`）を追加。
- `nemawashi-orchestrator.json` → `stakeholder-consensus-orchestrator.json` にリネーム、`variant` フィールドを context に追加。
- `communication_style` の `honne` / `tatemae` は enum 値として保持（文化依存の具体値）。

#### P1-3. Review Gate Registry への登録 ✅ 完了（2026-04-20）
- `mission-review-gate-registry.json` に `STAKEHOLDER_ALIGNMENT` / `DISSENT_RESOLUTION` / `REHEARSAL_READINESS` / `INTENT_DRIFT` を追加。
- `distillation_gate` は P0-4 再検討で不要と判定（worker lifecycle と重複しない）。
- `mode-standard-decision-support` mode-rule で decision_support ミッションを standard モードに昇格。

#### P1-4. Delegation Preflight の path-scope 拡張 ✅ 完了（2026-04-20）
- `path-scope-policy.json` に `confidential_heuristics` と `confidential_relationships` の scope class を追加。
- mission-aware / actuator-aware な強制は現状 description に明記。enforcement point は preflight / runtime 層に委譲（後続タスク）。

#### P1-5. Team Composition の判断支援ロール追加 ✅ 完了（2026-04-20）
- `team-role-index.json`（実ファイル名）に `devils_advocate` / `counterparty_persona` / `facilitator` / `relationship_curator` の 4 ロールを追加。`owner` の `allowed_delegate_team_roles` にも登録。

#### P1-6. Golden Scenario Pack の拡張 ✅ 完了（2026-04-20）
- `mission-orchestration-scenario-pack.json` に 4 シナリオ追加：
  - golden: `golden-decision-stakeholder-consensus` / `golden-decision-hypothesis-divergence`
  - controlled-failure: `failure-decision-skip-stakeholder-alignment` / `failure-decision-heuristic-tier-violation`

#### P1-7. Intent Delta 計装（論点 6 新規） ✅ 基盤完了（2026-04-20）
- **実装済み**：
  - `intent-snapshot.schema.json` / `intent-delta.schema.json`
  - `libs/core/intent-delta.ts`：`computeIntentDelta` / `goalSimilarity`（Jaccard） / `classifyDrift` / `isBlockingDrift`。閾値は `DEFAULT_THRESHOLDS` で調整可能。
  - `libs/core/intent-delta.test.ts`：14 ケース（identical / disjoint / field diff / cross-mission refusal）通過。
  - `mission-review-gate-registry.json` に `INTENT_DRIFT` ゲート追加。
- **残件（次イテレーション）**：ミッションライフサイクル遷移での snapshot emission hooks、execution-receipt への intent_delta 累積記録。

### P2 — スタブ実装化・新アクチュエータへの接続

#### P2-1. decision-ops の LLM 依存 op を実装化 ✅ contract 完了（2026-04-20）
- `libs/core/reasoning-backend.ts`：`ReasoningBackend` インタフェース（divergePersonas / crossCritique / synthesizePersona / forkBranches / simulateBranches）と stub 実装。`registerReasoningBackend` でホスト CLI アダプタを差し込める。
- 5 op のロジックは現状 stub backend 経由で従来挙動を維持。wisdom-actuator decision-ops を本 contract に移植するのは follow-up（ホスト CLI 委譲の実装はモデル世代に依存するため別セッションで行う）。

#### P2-2. 音声系 op の voice actuator 接続 ✅ contract 完了（2026-04-20）
- `libs/core/voice-bridge.ts`：`VoiceBridge` インタフェース（runRoleplaySession / runOneOnOneSession）と stub 実装。`_synthetic: true` フラグで合成 transcript と governed voice run を下流が識別可能。
- 実際の voice-engine-registry / voice-generation-runtime への結線は bridge 実装として別 commit で追加する想定（現在は stub がセッションを捏造）。

#### P2-3. Relationship-graph を presence / voice actuator に結線 ✅ store 完了（2026-04-20）
- `libs/core/relationship-graph-store.ts`：`recordInteraction`（信頼アクチュエータが rolling history に追記）、`suggestFieldUpdate`（trust_level 等は pending_suggestions に queue、直接変更しない）、read helper 群。path-traversal 拒否、20-entry ロールキャップ、neutral trust=3 で auto-create。
- 各アクチュエータが interaction ごとに `recordInteraction` を呼ぶ結線は presence / voice actuator 側の follow-up。

#### P2-4. heuristic-entry の tier 変更 ✅ 完了（2026-04-20）
- schema / 格納先 / judgment-rules / intuition-capture-protocol を **personal → confidential** に移行。新規ファイルは存在しなかったためデータ移行は不要。承継可能性を確保（CEO 業務代替ビジョン整合）。
- mission-aware な writer 強制は path-scope description に明記、実行は preflight 層へ委譲。

#### P2-5. Heuristic feedback loop の実装 ✅ 完了（2026-04-20）
- `libs/core/heuristic-feedback.ts`：`validateHeuristic`（成果 → validity_score を算出）、`scoreValidity`（success/partial/failure + optional metric_score）、`summarizeHeuristics`（retrospective 用レポート）。冪等再評価可。
- 12 テスト通過。retrospective ミッションフェーズから `summarizeHeuristics` を呼ぶ結線は follow-up。

#### P2-6. approval-gate を risky ops と結線 ✅ 完了（2026-04-20）
- `approval-policy.json` を 1.1.0 に更新、`secret:grant_access` / `auth:grant_authority` / `config:update`（governance|policy|review_gate scope）/ `vault:write` ルールを追加。
- `libs/core/risky-op-registry.ts`：`RISKY_OPS` 定数と `requireApprovalForOp` ディスパッチャ。call-site は correlation / intent id の boilerplate なくゲート可能。
- 既存 risky 呼び出し（例：`secret-guard.grantAccess`）を本 registry に移植するのは follow-up。

### P3 — 文書整合と吸収 ✅ 全完了（2026-04-20）

#### P3-1. 判断支援の設計根拠ドキュメント ✅
- `knowledge/public/architecture/decision-support-design-rationale.md` 新規作成。absorption-plan 形式でなく **design-rationale 形式**。参照文献 7 件、Kyberion 契約対応表、意図ループ配置、可換性、倫理境界を明記。

#### P3-2. Concept Map の更新 ✅
- `kyberion-concept-map.md` に「Cross-Cutting: The Intent Loop」節を追加。既存 5 層モデルを維持しつつ、6 段のループが層を横切るビューを追加。reading order の先頭に `INTENT_LOOP_CONCEPT.md` を配置。

#### P3-3. Hardening Backlog との合流 ✅
- `hardening-backlog.md` に `Priority 3.5: Decision-Support Integration` 節を追加。P1-1〜P2-6 の見出しだけを転記（詳細は本書に集約、二重管理防止）。

#### P3-4. CEO_SCENARIOS.md の新アクチュエータ反映 ✅
- voice/video governed stack の適用可能シナリオ表と、判断支援系 11-15（consensus / hypothesis / rehearsal / negotiation_prep / intuition_capture）を追記。

#### P3-5. USE_CASES.md の mission class 表記統一 ✅
- 20 ユースケース全件に mission_class / delivery_shape / workflow_template / risk_profile を明示した対応表を追加。判断支援系は CEO_SCENARIOS.md 側へ案内。

---

## 4. 実行順序の推奨

```
P0-1 → P0-2 → (P0-3, P0-4, P0-5 並行) → (P3-1 着手可)
  → P1-1 → (P1-2, P1-2b, P1-3, P1-5 並行) → P1-4 → P1-6
  → P1-7（独立着手可。P0-4, P1-3 完了後は本線に組み込み）
  → P2-1 → (P2-2, P2-3, P2-6 並行) → P2-4 → P2-5
  → P3-2 → P3-3 → (P3-4, P3-5 並行)
```

- **P0 クリア**で安全状態を回復。
- **P1 クリア**で判断支援がミッションとして呼び出せる。
- **P1-7 クリア**で意図ループの閉じを実行中に観測できる（概念の実効化）。
- **P2 クリア**で価値が実際に出る。
- **P3 クリア**で文書が整合。

---

## 5. 未決の論点（要合意）

前段の詰めで消化しきれなかった派生論点：

1. **heuristic 承継ポリシーの粒度**：confidential tier に置くとして、誰に開示するか（ミッションオーナーのみ / 承継エージェント / 組織全体）。
2. **文化 variant の配置場所**：`knowledge/public/` に骨格を置き variant は `knowledge/confidential/{org}/variants/` に置く、等の分離方針。
3. **intent_delta の閾値設計**：初期値は保守的（小さな変化で blocking）にするか寛容にするか。ログを貯めてから学習するのが筋だが、ブートストラップ時の既定値が必要。
4. **承認機構統合後の移行計画**：P0-5 で勝者が決まった後、他方を使っているテスト・ドキュメントの一括移行をどのタイミングで行うか。

これらは P0-2 の rebase 方針合意と同じ機会で決めたい。

---

## 参照

- `docs/INTENT_LOOP_CONCEPT.md` — 本バックログの拠り所となる概念
- `knowledge/public/architecture/hardening-backlog.md` — 実行細部担保の既存計画
- `knowledge/public/architecture/studio-agent-orchestration-absorption-plan.md` — origin/main のオーケストレーション設計思想
- `knowledge/public/architecture/cli-harness-coordination-model.md` — 可換層の責務分割
