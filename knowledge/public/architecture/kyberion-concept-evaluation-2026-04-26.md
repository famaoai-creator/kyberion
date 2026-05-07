---
title: Kyberion コンセプト評価と実装改善計画
category: Architecture
tags: [concept, evaluation, abstraction, implementation-plan, codex]
importance: 10
author: Codex
audit_date: 2026-04-26
last_updated: 2026-04-26
---

# Kyberion コンセプト評価と実装改善計画

## 1. 目的

Kyberion の全体コンセプトを確認し、抽象化の妥当性を評価したうえで、Codex 5.3 が実装可能な粒度へ改善ポイントを分解する。

この文書は評価メモであると同時に、今回の実装 sweep の完了記録でもある。主要な改善は既にコードと契約に反映済みであり、残る役割はその対応関係を固定することにある。

参照した主な資料:

- `README.md`
- `docs/QUICKSTART.md`
- `docs/USER_EXPERIENCE_CONTRACT.md`
- `docs/INTENT_LOOP_CONCEPT.md`
- `docs/archive/CONCEPT_INTEGRATION_BACKLOG.md`
- `docs/COMPONENT_MAP.md`
- `knowledge/public/architecture/organization-work-loop.md`
- `knowledge/public/architecture/kyberion-concept-map.md`
- `knowledge/public/architecture/enterprise-operating-kernel.md`
- `knowledge/public/architecture/project-mission-artifact-service-model.md`
- `knowledge/public/architecture/management-control-plane.md`
- `knowledge/public/architecture/corporate-memory-loop.md`
- `knowledge/public/architecture/agent-mission-control-model.md`

## 2. 全体コンセプトの要約

Kyberion は、組織の曖昧な意図を、統治された実行、証跡、再利用可能な記憶へ変換する Organization Work Loop engine である。

外部の利用者体験は単純化されている。

```text
Intent -> Plan -> Result
```

内部では、より長い組織作業ループを扱う。

```text
Intent
-> Context
-> Resolution
-> Outcome Design
-> Runtime Design
-> Teaming
-> Authority
-> Execution
-> Accounting
-> Learning
```

さらに、実装上の不可換な中核として「意図ループ」が置かれている。

```text
receive -> clarify -> preserve -> execute -> verify -> learn
```

この整理は妥当である。Kyberion はチャット UI でも単なる tool runner でもなく、意図、権限、実行、証跡、学習を閉じる組織作業カーネルを目指しているためである。

## 3. 抽象化評価

### 3.1 強い点

| 評価軸 | 判定 | 理由 |
|---|---:|---|
| ユーザー体験の単純化 | 高 | `Intent -> Plan -> Result` により、ADF、Actuator、Mission を利用者へ露出しすぎない。 |
| 内部統治モデル | 高 | Project、Mission、Task Session、Artifact、Service Binding、Vault、Evidence の分離が明確。 |
| 実行責任の分離 | 高 | Mission は契約、Agent は権限を受けた actor、Actuator は物理実行層という責務分離がある。 |
| モデル可換性 | 高 | 推論モデル、CLI ホスト、Actuator 実装を可換層として扱い、意図ループを不可換にしている。 |
| 学習ループ | 中高 | Corporate Memory Loop により、実行を再利用可能な組織知へ戻す思想がある。 |

### 3.2 弱い点

| 課題 | 影響 | 症状 |
|---|---|---|
| 上位概念が複数文書に分散 | 新規実装時にどれを正とするか迷う | Work Loop、Enterprise Kernel、Concept Map、Intent Loop が並列に見える。 |
| Resolution の実装契約が薄い | direct answer / task session / mission / project bootstrap の分岐が surface ごとに揺れる | 文書上のルールはあるが、型と contract test が弱い。 |
| Outcome Design が開始条件として固定されていない | 完了判定が「作業した」寄りになる | success criteria、expected artifact、evidence requirement が必須化されていない。 |
| Artifact / Evidence / Memory の lineage が薄い | Accounting と Learning が閉じにくい | 証跡は残っても、再利用知識への promotion が定型化されていない。 |
| Surface ごとの語彙統一が不足 | Slack、Chronos、Presence、Terminal で同じ仕事が違う体験に見える | User Experience Contract はあるが、実装を縛るテストが不足。 |

## 4. 推奨する抽象化

概念を削るより、正本となる語彙を固定する。

### 4.1 外部語彙

利用者に見せる語彙は次の 4 つに寄せる。

| 外部語彙 | 意味 | 内部対応 |
|---|---|---|
| Request | 何を頼んだか | Intent、execution brief |
| Plan | どう進めるか | Resolution、Outcome Design、Runtime Design |
| State | 今どうなっているか | Mission state、Task Session state、approval state |
| Result | 何が返ったか | Artifact、Delivery Pack、Evidence summary |

### 4.2 内部カーネル

内部 primitive は次の 7 つを正本にする。

| 内部 primitive | 役割 |
|---|---|
| Project | 長期的な意味と事業文脈 |
| Mission | 監査可能な durable execution |
| Task Session | 会話的で bounded な作業 |
| Artifact | 成果物または delivery record |
| Service Binding | 外部システム接続の統治契約 |
| Evidence | 説明責任と検証の材料 |
| Memory Candidate | 再利用知識へ昇格する候補 |

### 4.3 不可換ループ

実装の正本は、次の 6 段が観測可能で閉じているかに置く。

```text
receive -> clarify -> preserve -> execute -> verify -> learn
```

Work Loop や Enterprise Kernel は、このループを組織スケールに拡張した説明モデルとして扱う。

## 5. 改善方針

新しい巨大概念を追加するより、既存概念を実行時契約へ落とす。

優先順位:

1. Intent Resolution を canonical contract 化する。
2. Outcome Design を Mission / Task Session の開始条件にする。
3. Artifact / Evidence / Memory Candidate の lineage を強制する。
4. Surface 表示を User Experience Contract に対してテストする。
5. Learning を promotion queue と ratification flow に落とす。

## 6. Codex 5.3 実装バックログ

以下は当初の改善提案であり、2026-04-26 の実装 sweep で大半を反映済みである。

### P0-1. Concept Canonical Index を作る

目的:

- 分散している上位概念の読み順と正本を固定する。

実装候補:

- 新規: `knowledge/public/architecture/kyberion-canonical-concept-index.md`
- 更新: `docs/COMPONENT_MAP.md`
- 更新: `README.md`

受け入れ条件:

- 新規参加者が読むべき順序が 5 文書以内に収まる。
- `mission`、`task session`、`project` の使い分けが同じ表で説明される。
- Work Loop、Enterprise Kernel、Intent Loop、Concept Map の関係が 1 ページで分かる。

実装状況:

- `knowledge/public/architecture/kyberion-canonical-concept-index.md` を作成済み。
- `README.md` と `docs/COMPONENT_MAP.md` の更新余地はあるが、実装判断の一次参照は成立している。

### P0-2. Intent Resolution Contract を型として固定する

目的:

- Intent から direct answer / task session / mission / project bootstrap への分岐を surface 非依存にする。

実装候補:

- 新規: `libs/core/intent-resolution-contract.ts`
- 新規: `schemas/intent-resolution.schema.json`
- 更新: `libs/core/intent-resolution.ts`
- 追加: `libs/core/intent-resolution-contract.test.ts`

最小フィールド:

```ts
interface IntentResolutionContract {
  request_id: string;
  normalized_intent: string;
  missing_inputs: string[];
  resolution_shape: "direct_answer" | "task_session" | "mission" | "project_bootstrap";
  outcome_kind: "answer" | "artifact" | "approval_ready_plan" | "service_change" | "status_report";
  authority_level: "autonomous" | "approval_required" | "human_clarification_required";
  project_context?: { project_id?: string; confidence: number };
  rationale: string;
}
```

受け入れ条件:

- 代表ユースケース 10 件で `resolution_shape` が deterministic に返る。
- `missing_inputs` がある場合は実行に進まず clarification shape になる。
- `docs/USE_CASES.md` の分類と矛盾しない。

実装状況:

- `libs/core/intent-resolution-contract.ts` と `libs/core/intent-resolution-contract.test.ts` で固定済み。
- `schemas/intent-resolution.schema.json` と `scripts/check_contract_schemas.ts` に接続済み。

### P1-1. Outcome Contract を開始条件にする

目的:

- 「何が返れば完了か」を Mission / Task Session 作成時に固定する。

実装候補:

- 新規: `libs/core/outcome-contract.ts`
- 新規: `schemas/outcome-contract.schema.json`
- 更新: `libs/core/task-session.ts`
- 更新: `scripts/mission_controller.ts`

最小フィールド:

```ts
interface OutcomeContract {
  outcome_id: string;
  requested_result: string;
  deliverable_kind: string;
  success_criteria: string[];
  evidence_required: boolean;
  expected_artifacts: Array<{ kind: string; storage_class: string }>;
  verification_method: "self_check" | "review_gate" | "human_acceptance" | "test";
}
```

受け入れ条件:

- Mission または Task Session 作成時に outcome contract が保存される。
- `success_criteria` の空配列を許可しない。
- `evidence_required: true` の完了時は evidence ref を必須にする。

実装状況:

- `libs/core/outcome-contract.ts` と `libs/core/outcome-contract.test.ts` で固定済み。
- `schemas/outcome-contract.schema.json` と契約ゲートに接続済み。

### P1-2. Artifact Ownership Registry を導入する

目的:

- 成果物が Project / Mission / Task Session / Service Binding と紐づく状態を保証する。

実装候補:

- 新規: `libs/core/artifact-registry.ts`
- 新規: `schemas/artifact-record.schema.json`
- 保存先: `active/shared/artifacts/registry.jsonl`
- 更新候補: `artifact-actuator`、`media-actuator`、`task-session` artifact path 周辺

最小フィールド:

```ts
interface ArtifactRecord {
  artifact_id: string;
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
  storage_class: "repo" | "artifact_store" | "vault" | "tmp" | "external_ref";
  path?: string;
  external_ref?: string;
  created_at: string;
  evidence_refs: string[];
}
```

受け入れ条件:

- 新規 artifact 登録時に owner 情報が 1 つ以上必須。
- `tmp` storage_class は delivery result として扱わない。
- registry は append-only で、既存 evidence model と競合しない。

実装状況:

- `libs/core/artifact-registry.ts` と `libs/core/artifact-registry.test.ts` で固定済み。
- `schemas/artifact-record.schema.json` と契約ゲートに接続済み。

### P1-3. Surface UX Contract Tests を追加する

目的:

- Terminal、Slack、Chronos、Presence が同じ mental model を出すようにする。

実装候補:

- 新規: `libs/core/surface-ux-contract.ts`
- 新規: `libs/core/surface-ux-contract.test.ts`
- 更新: `docs/USER_EXPERIENCE_CONTRACT.md`

受け入れ条件:

- response が Request / Plan / State / Result / Next Action のいずれかを含む。
- raw ADF、actuator 名、internal enum がデフォルト表示に漏れない。
- `approval_required` のとき consequence と unblock action が含まれる。

実装状況:

- `libs/core/surface-ux-contract.ts` と `libs/core/surface-ux-contract.test.ts` で固定済み。

### P2-1. Intent Delta をライフサイクル遷移に接続する

目的:

- 既存 Intent Delta 基盤を、実行中の drift 検知に使える状態にする。

実装候補:

- 更新: `libs/core/mission-orchestration-worker.ts`
- 更新: `scripts/mission_controller.ts`
- 更新: `libs/core/intent-delta.ts`
- 追加: checkpoint / verify / finish 時の delta emission test

受け入れ条件:

- mission start / checkpoint / verify / finish で `intent_snapshot` を生成する。
- 前回 snapshot と比較して `intent_delta` を保存する。
- blocking drift の場合、finish を拒否または review gate 待ちにする。
- finish 記録に cumulative intent_delta summary が残る。

実装状況:

- `scripts/refactor/mission-intent-delta.ts` と `scripts/refactor/mission-intent-delta.test.ts` で lifecycle snapshot / drift summary が固定済み。

### P2-2. Memory Promotion Queue を作る

目的:

- Corporate Memory Loop を queue として実装し、学習ループを閉じる。

実装候補:

- 新規: `libs/core/memory-promotion-queue.ts`
- 新規: `schemas/memory-candidate.schema.json`
- 保存先: `active/shared/memory/promotion-queue.jsonl`
- 更新: `libs/core/heuristic-feedback.ts`

最小フィールド:

```ts
interface MemoryCandidate {
  candidate_id: string;
  source_type: "mission" | "task_session" | "artifact" | "incident";
  source_ref: string;
  proposed_memory_kind: "sop" | "template" | "heuristic" | "risk_rule" | "clarification_prompt";
  summary: string;
  evidence_refs: string[];
  sensitivity_tier: "public" | "confidential" | "personal";
  ratification_required: boolean;
  status: "queued" | "approved" | "rejected" | "promoted";
}
```

受け入れ条件:

- mission finish 後に candidate を queue できる。
- `evidence_refs` なしの promotion を拒否できる。
- public tier への promotion は confidential / personal 参照を含まない。

実装状況:

- `libs/core/memory-promotion-queue.ts` と `libs/core/memory-promotion-queue.test.ts` で固定済み。

### P2-3. Management Control Plane の next action を deterministic にする

目的:

- Chronos が「見える」だけでなく、次に何をすべきかを安全に提示できるようにする。

実装候補:

- 新規: `libs/core/next-action-contract.ts`
- 更新: `scripts/control_plane_cli.ts`
- 更新: Chronos route または presenter 層

next action 種別:

- `request_clarification`
- `approve`
- `inspect_evidence`
- `retry_delivery`
- `promote_mission_seed`
- `resume_mission`

受け入れ条件:

- 各 next action に reason、risk、suggested command または suggested surface action がある。
- approval 系 action は approval policy と整合する。
- destructive action は生成しないか、`approval_required` になる。

実装状況:

- `libs/core/next-action-contract.ts` と `libs/core/next-action-contract.test.ts` で固定済み。

### P3-1. Concept Drift Guard を CI に追加する

目的:

- 文書と実装がズレ続けることを防ぐ。

実装候補:

- 新規: `scripts/check_concept_contracts.ts`
- 更新: `package.json` の `validate`
- 対象: canonical concept index、schemas、`USER_EXPERIENCE_CONTRACT.md`

受け入れ条件:

- `pnpm run validate` で concept contract check が走る。
- 初期は warning mode で導入できる。
- canonical primitive が docs / schema から消えた場合に検出できる。

実装状況:

- `pnpm run validate` により `check:governance-rules` と `check:contract-schemas` が常時実行されるため、概念逸脱の一次検知は既に CI へ統合済み。
- 必要に応じてこの章を専用 script に分離できるが、現時点では既存の validate 経路で十分に機能している。

## 7. 推奨実装順序

```text
P0-1 Concept Canonical Index
  -> P0-2 Intent Resolution Contract
  -> P1-1 Outcome Contract
  -> P1-2 Artifact Ownership Registry
  -> P1-3 Surface UX Contract Tests
  -> P2-1 Intent Delta Lifecycle Hooks
  -> P2-2 Memory Promotion Queue
  -> P2-3 Deterministic Next Actions
  -> P3-1 Concept Drift Guard
```

この順序にする理由:

1. 先に語彙と分岐契約を固定しないと、Mission / Artifact / Memory 実装が surface ごとに揺れる。
2. Outcome Contract を先に入れると、Artifact Registry と Evidence の要件が明確になる。
3. Memory Promotion は evidence lineage ができてから実装したほうが誤学習を避けやすい。
4. CI guard は最初から厳格にすると既存文書で詰まるため、最後に warning mode で導入するのが安全。

## 8. 最終評価

Kyberion のコンセプトは強い。特に、意図を成果まで運び、証跡を残し、学習へ戻すというループは、推論モデルや CLI ホストが可換になる前提と整合している。

ただし、現状の弱点は「思想が文書としては強いが、実行時契約として完全には閉じていない」点である。次の実装焦点は、概念追加ではなく契約化である。

最も重要な改善は次の 3 つ。

1. Intent Resolution Contract で入口の分岐を固定する。
2. Outcome Contract と Artifact Registry で完了と成果物を固定する。
3. Memory Promotion Queue で学習ループを実装単位に落とす。

この 3 点が入ると、Kyberion は「複雑な概念を持つシステム」から「意図、実行、証跡、学習が閉じた組織作業カーネル」に近づく。

## 9. 実装完了メモ

2026-04-26 の sweep で、以下はコード・テスト・検証まで完了した。

1. Intent Resolution Contract
2. Outcome Contract
3. Artifact Registry / Artifact Record
4. Surface UX Contract
5. Intent Delta lifecycle hooks
6. Memory Promotion Queue
7. Next Action Contract
8. Governance contract sweep for all remaining catalog / policy records
9. Video render policy / backend alignment

残りの改善は主に文書の自然言語表現と、必要に応じた個別実装の微調整である。
