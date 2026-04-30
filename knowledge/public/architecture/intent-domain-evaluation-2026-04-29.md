---
title: Kyberion Intent Domain Evaluation
category: Architecture
tags: [intent, evaluation, abstraction, mission, actuators, knowledge, environment, team-composition]
importance: 10
author: Codex
audit_date: 2026-04-29
last_updated: 2026-04-29
---

# Kyberion インテント領域評価レポート

## 1. 目的

Kyberion 全体を「何に対して、何を実施するのか」というインテント領域でレビューし、論理的整合性、抽象化の適切性、拡張性、環境準備から活用までの連続性を評価する。

評価対象の主軸は次の 5 領域である。

| 領域 | 問い |
|---|---|
| 目的遂行インテント | ユーザーの成果目的を、成果物・判断・変更・運用へ落とせるか |
| 環境整備インテント | Kyberion 自体、actuator、LLM、外部連携、権限を準備・検証・活用できるか |
| ナレッジ活用・整理インテント | 3-tier knowledge を検索・注入・整理・昇格・廃棄できるか |
| 状態確認インテント | Kyberion 自身、mission、runtime、環境、証跡の状態を説明できるか |
| ミッションプロセスインテント | mission 作成、分類、計画、team 編成、委譲、実行、検証、学習を扱えるか |

## 2. 参照した主な定義

- [`kyberion-intent-catalog.md`](knowledge/public/architecture/kyberion-intent-catalog.md)
- [`intent-classifier-routing.md`](knowledge/public/architecture/intent-classifier-routing.md)
- [`intent-coverage-matrix.md`](knowledge/public/architecture/intent-coverage-matrix.md)
- [`intent-observability-model.md`](knowledge/public/architecture/intent-observability-model.md)
- [`agent-mission-control-model.md`](knowledge/public/architecture/agent-mission-control-model.md)
- [`mission-runtime-primitives.md`](knowledge/public/architecture/mission-runtime-primitives.md)
- [`mission-team-composition-model.md`](knowledge/public/architecture/mission-team-composition-model.md)
- [`actuator-op-taxonomy.md`](knowledge/public/architecture/actuator-op-taxonomy.md)
- [`standard-intents.json`](knowledge/public/governance/standard-intents.json)
- [`intent-resolution-policy.json`](knowledge/public/governance/intent-resolution-policy.json)
- [`mission-classification-policy.json`](knowledge/public/governance/mission-classification-policy.json)
- [`mission-workflow-catalog.json`](knowledge/public/governance/mission-workflow-catalog.json)
- [`model-registry.json`](knowledge/public/governance/model-registry.json)
- [`runtime-design-profiles.json`](knowledge/public/governance/runtime-design-profiles.json)
- [`environment-manifests/`](knowledge/public/governance/environment-manifests)
- [`CAPABILITIES_GUIDE.md`](CAPABILITIES_GUIDE.md)

## 3. 総合評価

Kyberion の中核思想は一貫している。外部 UX は `Request -> Plan -> State -> Result` に単純化され、内部では intent resolution、mission classification、workflow catalog、actuator、evidence、memory promotion に分解される。この方向性は妥当である。

一方で、現状の正本は複数の JSON と Markdown に分散している。特に「目的遂行」「環境整備」「ナレッジ」「状態確認」「ミッションプロセス」という上位インテント領域が、機械可読な単一モデルとして固定されていない。そのため実装者は、`standard-intents.json`、`mission-classification-policy.json`、`mission-workflow-catalog.json`、`environment-manifests/`、actuator catalog、team template を横断的に読んで接続を推測する必要がある。

評価結果は次の通り。

| 評価軸 | 判定 | 根拠 |
|---|---:|---|
| 論理的整合性 | B+ | UX契約、mission、actuator、knowledge、evidence の方向性は整合している。ただし intent 領域と実行契約の対応が分散している。 |
| 抽象化の適切性 | B | `Mission`、`Task Session`、`Actuator`、`Evidence`、`Memory` は良い抽象。上位の `IntentTarget` と `IntentAction` が未固定。 |
| 拡張性 | B+ | actuator manifest、environment manifest、model registry、team role は拡張可能。ただし新規 intent を追加した時の coverage gate が弱い。 |
| 環境準備から活用まで | B | `EnvironmentCapability` と manifest により準備・検証はある。intent catalog から readiness gate への結線はまだ薄い。 |
| ナレッジ活用 | B | 3-tier、wisdom、distill、promotion はある。検索以外の整理・昇格・廃棄 intent が user-facing catalog に不足。 |
| 状態確認 | B | baseline/vital/health/diagnostics はある。Kyberion 自身の状態確認 intent と runtime routing が限定的。 |
| ミッションプロセス | A- | mission class、workflow、team composition、single-owner multi-worker は強い。チーム組成を intent として扱う表層が弱い。 |

## 4. 推奨する正本抽象

現状の弱点は概念不足ではなく、概念間の結線不足である。新しい大規模概念を追加するより、次の 4 軸を machine-readable に固定するのがよい。

```text
Intent = Target + Action + Object + ExecutionShape + GovernanceEnvelope
```

| 軸 | 意味 | 例 |
|---|---|---|
| `IntentTarget` | 何に対して実施するか | `outcome`, `environment`, `actuator`, `llm`, `knowledge`, `system_state`, `mission_process`, `agent_team`, `external_service` |
| `IntentAction` | 何を実施するか | `create`, `change`, `inspect`, `diagnose`, `prepare`, `verify`, `activate`, `query`, `distill`, `organize`, `compose`, `delegate`, `execute`, `review`, `promote` |
| `IntentObject` | 対象物の具体型 | `project`, `artifact`, `reasoning_backend`, `environment_manifest`, `knowledge_corpus`, `mission`, `team_blueprint`, `actuator_contract` |
| `ExecutionShape` | どの実行形に落とすか | `direct_reply`, `task_session`, `mission`, `project_bootstrap`, `pipeline`, `actuator_action` |
| `GovernanceEnvelope` | どの統治条件で実行するか | `tier`, `risk_profile`, `approval_required`, `evidence_required`, `readiness_required`, `review_gate` |

この抽象を導入すると、ユーザーの自然言語と backend 実行の間が次のように安定する。

```text
ユーザー発話
-> standard intent
-> IntentTarget / IntentAction / IntentObject
-> mission_class / workflow / team / actuator / readiness
-> evidence / result / memory
```

## 5. 領域別レビュー

### 5.1 目的遂行インテント

現行の強み:

- `standard-intents.json` は `bootstrap-project`、artifact 生成、service inspection、knowledge query、cross-project remediation、incident-informed review などを user-facing に定義している。
- `mission-classification-policy.json` は product delivery、content/media、research/absorption、decision support、customer engagement、operations/release に分類できる。
- `intent-coverage-matrix.md` は runtime coverage を `implemented / partial / missing` で追跡している。

課題:

- `standard-intents.json` の `category` が主に `surface` であり、目的遂行と環境整備、状態確認、ナレッジ整理、ミッションプロセスの区別が表現できない。
- 目的遂行 intent は成果物生成に強いが、戦略判断、意思決定、顧客対応、横断 remediation などは `task_session` の analysis に寄りがちで、workflow への bind が弱い。
- `intent-resolution-policy.json` の legacy candidates は限定的で、catalog 全体を deterministic に支える coverage policy になっていない。

評価:

目的遂行の抽象は妥当。ただし `intent_id -> mission_class -> workflow_template -> outcome -> evidence` の対応を coverage test で強制する必要がある。

### 5.2 環境整備インテント

現行の強み:

- `kyberion-intent-catalog.md` は `platform_onboarding`、reasoning backend、voice/audio、CI/CD、SIEM、secret、actuator inventory、system upgrade を環境統合 intent として整理している。
- `EnvironmentCapability` は `probeManifest`、`bootstrapManifest`、`verifyReady` を持ち、準備から readiness 検証までを扱える。
- `environment-manifests/` は runtime baseline、reasoning backend、schema integrity、knowledge tier hygiene、MOS operator surface などを個別 manifest として表現している。
- `model-registry.json` は model の role fit、cost、latency、structured output、tool use、reasoning confidence を持つ。

課題:

- 環境整備 intent は文書上は明確だが、`standard-intents.json` の user-facing catalog には `bootstrap-environment`、`verify-environment-readiness`、`configure-reasoning-backend`、`register-actuator` のような一級 intent が不足している。
- `platform_onboarding` は mission class として存在するが、個別環境 manifest と intent resolution の対応が明示されていない。
- LLM / reasoning backend の選択は env var と model registry に分散し、intent resolution の段階で `requires_reasoning_capability` として明示されていない。

評価:

環境準備の実装基盤は強い。弱いのは「環境を準備してから活用する」という lifecycle を intent catalog と readiness gate へ明示的に接続する部分である。

### 5.3 Actuator 整備・活用インテント

現行の強み:

- `CAPABILITIES_GUIDE.md` と `global_actuator_index.json` により manifest-backed actuator が可視化されている。
- `actuator-op-taxonomy.md` は physical primitives、semantic transforms、control-plane actions の境界を示している。
- `actuator-intent-normalization.md` は自然言語を actuator へ直接渡さず、execution brief に正規化する方針を示している。

課題:

- `IntentTarget / IntentAction` と actuator op の bind が統一レジストリとして固定されていない。
- どの intent がどの actuator capability と readiness manifest を要求するかが、文書・実装・pipeline に分散している。
- actuator を「追加する」「更新する」「検証する」「非推奨化する」ための operator intent が catalog 上で弱い。

評価:

actuator の物理境界はよく整理されている。次は「intent から actuator contract へ行く前の正規化層」を machine-readable にし、runtime drift を防ぐべきである。

### 5.4 ナレッジ活用・整理インテント

現行の強み:

- 3-tier knowledge protocol は `public / confidential / personal` と mission tier の継承を定義している。
- `wisdom-actuator`、knowledge query、incident-informed review、cross-project remediation、mission distill、memory promotion が存在する。
- `mission_controller distill`、memory candidate、post-release retrospective により learn loop は設計されている。

課題:

- user-facing catalog にあるナレッジ intent は `knowledge-query` が中心で、`distill`、`organize`、`promote`、`retire`、`sanitize`、`reconcile`、`index` が一級 intent として不足している。
- `knowledge_lifecycle` という mission class がないため、整理・昇格・廃棄の work が `research_and_absorption` または operator pipeline に寄りやすい。
- ナレッジの利用時に「検索」「注入」「引用」「抽象化」「昇格候補化」のどこまで行ったかを示す execution receipt が標準化されていない。

評価:

ナレッジの統治思想は強いが、利用と整理の intent が分離されていない。検索だけでなく lifecycle 操作を intent として公開する必要がある。

### 5.5 Kyberion 自身の状態確認インテント

現行の強み:

- `baseline-check`、`vital-check`、`full-health-report`、`system-diagnostics`、`agent-provider-check` が存在する。
- `intent-observability-model.md` は `Intent -> Slot -> Plan -> Execution -> Outcome` を trace shape として定義している。
- `mission_controller status`、audit chain、intent snapshot store、policy engine が状態説明の材料を持つ。

課題:

- `standard-intents.json` では状態確認が `inspect-service` に寄っており、Kyberion 自身の health、runtime、mission、environment readiness、audit integrity を分ける intent が不足している。
- `baseline-check` は session start gate として重要だが、ユーザーが自然言語で「Kyberion の状態を確認して」と言った時の resolution が正本化されていない。
- 状態確認結果を `State` として surfaces に返す UX と、operator 向け diagnostics の境界が明確でない。

評価:

観測材料はある。必要なのは「system_state に対して inspect/diagnose/verify を行う intent」を user-facing catalog と routing に昇格することである。

### 5.6 ミッションプロセス・チーム組成インテント

現行の強み:

- `agent-mission-control-model.md` は mission を durable contract、agent を authority を受けた actor と定義している。
- `mission-classification-policy.json` は class、delivery shape、risk profile、stage を持つ。
- `mission-workflow-catalog.json` は stage-gated、explore-then-govern、coordinated multi-track、decision support、customer engagement、platform onboarding を扱う。
- `mission-team-composition-model.md` と `mission-team-composer.ts` は authority role、team role、agent profile、mission team template を bind できる。
- `runtime-design-profiles.json` は single actor と single-owner multi-worker を分けている。

課題:

- `compose-mission-team`、`prewarm-team`、`rebalance-team`、`handoff-mission`、`review-worker-output` のような process intent が user-facing catalog で一級化されていない。
- チーム組成は mission runtime の内部機能としては強いが、intent resolution から `agent_team` target として扱う抽象が不足している。
- `mission_process` という mission class または explicit direct/process execution shape がなく、process 操作の governance envelope が曖昧になりやすい。

評価:

ミッション制御の抽象は Kyberion の強い部分である。次は、チーム編成や runtime prewarm を operator command ではなく intent として扱えるようにするべきである。

## 6. 論理的整合性の評価

論理構造は次の方向では整合している。

```text
Request
-> Intent Resolution
-> Mission Classification / Workflow Design
-> Team Composition / Runtime Design
-> Actuator / Pipeline Execution
-> Evidence / State / Result
-> Memory Promotion
```

ただし、現状は各段の接続が完全に強制されていない。

| 接続 | 現状 | 改善必要性 |
|---|---|---|
| `standard intent -> mission class` | 一部 rules あり | 高 |
| `standard intent -> workflow template` | mission class 経由で推定 | 中 |
| `standard intent -> actuator / pipeline` | catalog と pipeline に分散 | 高 |
| `standard intent -> environment readiness` | ほぼ暗黙 | 高 |
| `standard intent -> team template` | mission classification 経由 | 中 |
| `standard intent -> evidence / memory` | intent coverage と outcome pattern に分散 | 中 |

結論として、コンセプトは矛盾していないが、実装者が迷わないための join table が不足している。

## 7. 改善ポイント

### P0-1. Intent Domain Ontology を追加する

目的:

- 目的遂行、環境整備、ナレッジ、状態確認、ミッションプロセスを機械可読な正本にする。

実装候補:

- 新規: `knowledge/public/governance/intent-domain-ontology.json`
- 新規: `knowledge/public/schemas/intent-domain-ontology.schema.json`
- 更新: `knowledge/public/governance/standard-intents.json`
- 更新: `libs/core/intent-resolution.ts`

最小フィールド:

```json
{
  "intent_id": "verify-environment-readiness",
  "target": "environment",
  "action": "verify",
  "object": "environment_manifest",
  "execution_shape": "task_session",
  "mission_class": "platform_onboarding",
  "risk_profile": "review_required",
  "readiness_required": ["kyberion-runtime-baseline"],
  "evidence_required": ["readiness-report"]
}
```

受け入れ条件:

- 全 `standard-intents.json` intent が `target/action/object` を持つ。
- 全 intent が `execution_shape`、`risk_profile`、`outcome_ids` を持つ。
- coverage check が未分類 intent を失敗させる。

### P0-2. Intent Coverage Gate を追加する

目的:

- catalog、mission classification、workflow、outcome、actuator、readiness、team の drift を CI で検出する。

実装候補:

- 新規: `scripts/check_intent_domain_coverage.ts`
- 更新: `package.json` の `validate`
- 更新: `knowledge/public/governance/intent-coverage-matrix.json`

検査内容:

- すべての standard intent が ontology に存在する。
- `mission_class` が policy に存在する。
- `workflow_template` が catalog に存在する。
- `outcome_ids` が outcome catalog に存在する。
- `actuator_requirements` が global actuator index に存在する。
- `environment_requirements` が environment manifests に存在する。
- `team_template` が mission team templates に存在する。

### P0-3. User-facing intent category を再分類する

目的:

- `surface` / `operator` だけではなく、上位領域で検索・表示・routing できるようにする。

推奨カテゴリ:

- `outcome_execution`
- `environment_setup`
- `actuator_management`
- `llm_reasoning_setup`
- `knowledge_lifecycle`
- `system_observability`
- `mission_process`
- `governance_control`

受け入れ条件:

- 既存 intent は後方互換の `legacy_category` を持てる。
- runtime scoring は `surface` 固定ではなく `exposed_to_surface: true` を見る。

### P1-1. 環境整備 intent pack を追加する

追加候補:

- `bootstrap-kyberion-runtime`
- `verify-environment-readiness`
- `configure-reasoning-backend`
- `register-actuator-adapter`
- `verify-actuator-capability`
- `rotate-integration-secret`
- `run-system-upgrade-check`

結線:

- `environment-manifests/*`
- `bootstrap_environment.ts`
- `model-registry.json`
- `runtime-design-profiles.json`
- `system-upgrade-check` / `system-upgrade-execute`

### P1-2. ナレッジ lifecycle intent pack を追加する

追加候補:

- `query-knowledge`
- `distill-mission-knowledge`
- `organize-knowledge-assets`
- `promote-memory-candidate`
- `sanitize-knowledge-for-public-tier`
- `retire-stale-knowledge`
- `reconcile-knowledge-index`

推奨 mission class:

- `knowledge_lifecycle`

受け入れ条件:

- tier boundary が `GovernanceEnvelope` に含まれる。
- confidential/personal を public へ出す場合は sanitize evidence が必須。
- promotion / rejection が execution receipt に残る。

### P1-3. 状態確認 intent pack を追加する

追加候補:

- `check-kyberion-baseline`
- `check-kyberion-vital`
- `diagnose-kyberion-system`
- `inspect-mission-state`
- `inspect-runtime-supervisor`
- `verify-audit-chain`
- `inspect-environment-readiness`

受け入れ条件:

- ユーザー向け `State` summary と operator 向け diagnostics を分ける。
- `baseline-check` の status を自然言語 request から取得できる。
- `fatal_error` は direct reply ではなく operator intervention state を返す。

### P1-4. ミッションプロセス intent pack を追加する

追加候補:

- `create-mission`
- `classify-mission`
- `select-mission-workflow`
- `compose-mission-team`
- `prewarm-mission-team`
- `delegate-mission-task`
- `review-worker-output`
- `handoff-mission`
- `distill-mission`
- `close-mission`

推奨 target/action:

- `mission_process:create`
- `mission_process:classify`
- `agent_team:compose`
- `agent_team:prewarm`
- `mission_process:delegate`
- `mission_process:review`

受け入れ条件:

- single-owner rule を破らない。
- worker は mission-wide state を直接 mutation しない。
- `team-blueprint.json`、`staffing-assignments.json`、`execution-ledger.jsonl` の evidence が揃う。

### P1-5. Reasoning capability を intent resolution に入れる

目的:

- LLM を単なる環境変数ではなく、intent の要求能力として扱う。

追加フィールド候補:

```json
{
  "reasoning_requirements": {
    "mode": "divergent_analysis",
    "capability_tags": ["multi_step_reasoning", "structured_output"],
    "fallback_allowed": false
  }
}
```

適用例:

- decision support は divergent / critique capability を要求する。
- code change は tool use / structured output / deterministic verification を要求する。
- direct answer は low-latency surface model を許容する。
- environment bootstrap は stub でも可、ただし content generation は real backend required。

### P2-1. Intent-to-Actuator Binding Registry を追加する

目的:

- actuator の public op と intent の関係を一箇所で確認する。

実装候補:

- 新規: `knowledge/public/governance/intent-actuator-bindings.json`
- 新規: `knowledge/public/schemas/intent-actuator-bindings.schema.json`

最小フィールド:

- `intent_id`
- `target_actuators`
- `required_ops`
- `input_contract`
- `output_contract`
- `readiness_manifests`
- `approval_policy`

### P2-2. Intent Lifecycle Receipt を標準化する

目的:

- すべての intent が何を受け、何を決め、何を実行し、何を残したかを追跡できるようにする。

最小 trace:

```text
request -> intent_resolution -> readiness -> plan -> execution -> verification -> result -> memory
```

受け入れ条件:

- direct reply でも minimal receipt を残せる。
- mission は receipt を evidence に含める。
- memory promotion は receipt の result / verification から辿れる。

## 8. 優先実装順

| 優先 | 改善 | 理由 |
|---:|---|---|
| 1 | `intent-domain-ontology.json` | すべての領域を束ねる正本がないと drift が続く |
| 2 | `check_intent_domain_coverage.ts` | 新規 intent 追加時の破綻を CI で止める |
| 3 | `standard-intents.json` の category 再分類 | user-facing routing と operator routing の見通しを改善する |
| 4 | 環境整備・状態確認 intent pack | 準備から活用までの lifecycle を自然言語で扱えるようにする |
| 5 | ナレッジ lifecycle intent pack | Kyberion の学習ループを検索中心から整理・昇格中心へ拡張する |
| 6 | ミッションプロセス intent pack | team composition と delegation を command ではなく intent として扱う |
| 7 | reasoning capability binding | LLM 選択を環境変数依存から intent 要求に引き上げる |

## 9. 結論

Kyberion の現行コンセプトは、組織の曖昧な要求を governed execution と reusable knowledge に変換する方向で論理的に整合している。特に mission、actuator、environment manifest、team composition、evidence、memory の抽象は強い。

最大の改善点は、上位インテント領域の正本化である。目的遂行、環境整備、ナレッジ、状態確認、ミッションプロセスを `IntentTarget + IntentAction + IntentObject` として固定し、そこから mission class、workflow、actuator、readiness、team、evidence へ接続することで、Kyberion は「何を頼まれたら、何を準備し、誰が、どの権限で、何を実行し、何を残すか」を一貫して説明できる。

この改善は、既存の設計を置き換えるものではない。既存のカタログと runtime を結線する join layer を追加する改善である。
