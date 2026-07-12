---
title: ミッション・プレイブック：資材管理・IT運用・動的ワークフロー登録
category: Orchestration
tags:
  [
    orchestration,
    mission-playbooks,
    asset-management,
    sbom,
    it-operations,
    aws,
    simulation,
    dynamic-registration,
  ]
importance: 9
author: Ecosystem Architect
last_updated: 2026-07-09
---

# ミッション・プレイブック：資材管理・IT運用・動的ワークフロー登録

IT企業として重要性が増している(1)ソフトウェア資材管理(SBOM・鍵管理・版管理)、(2)他システムの IT運用自動化、(3)進めるワークフロー/ゲーティングを動的に追加する仕組み、の3本を kyberion のインテント→ゴール→リザルト・ループに取り込んだもの。実 AWS への適用はサンドボックス外・承認済みフローで行い、本プレイブックの範囲は**副作用なしのシミュレーションとガバナンス統制**まで。固有情報(顧客名・鍵の実値・内部ホスト名)は product ティアに置かない。

## 対象と実体

| #   | 対象                 | 実体                                                                                                     |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | ソフトウェア資材管理 | ワークフロー `software-asset-management`（intent 同名）                                                  |
| 2   | IT運用自動化         | ワークフロー `it-operations-automation`（intent 同名）                                                   |
| 3   | AWSシミュレーション  | パイプライン `pipelines/aws-operations-simulation.json`（IT運用の simulate フェーズが参照）              |
| 4   | 動的ワークフロー登録 | スクリプト `scripts/register_workflow.ts` + スキーマ `schemas/workflow-registration-request.schema.json` |

---

## 1. ソフトウェア資材管理 (`software-asset-management`)

資材インベントリ → SBOM生成 → 依存脆弱性スキャン → 鍵/シークレット棚卸し → 版管理・リリースタグ → 資材台帳登録。

| フェーズ              | 種別          | ゲート                     | 成果物                  | 備考                                         |
| --------------------- | ------------- | -------------------------- | ----------------------- | -------------------------------------------- |
| 資材インベントリ      | judgment      | `ASSET_INVENTORY_DONE`     | asset-inventory.json    | 所有者・環境・機微度                         |
| SBOM生成              | deterministic | `SBOM_COMPLETE`            | sbom.json               | CycloneDX/SPDX                               |
| 依存脆弱性スキャン    | deterministic | `VULN_CLEARED` (+人間)     | vuln-report.json        | `pipelines/dependency-vuln-scan.json` 再利用 |
| 鍵/シークレット棚卸し | judgment      | `KEY_ROTATION_OK` (+人間)  | key-inventory.json      | **秘密値は記録せず保管先参照のみ**           |
| 版管理・リリースタグ  | judgment      | `VERSION_TAGGED`           | version-record.json     | semver・成果物ハッシュ                       |
| 資材台帳登録          | approval      | `ASSET_REGISTERED` (+人間) | asset-ledger-entry.json | SBOM/脆弱性/鍵/版とトレース                  |

**ツール現状**（`CAPABILITIES_GUIDE.md`）: SBOM専用アクチュエータ(syft/cyclonedx)は未実装のため SBOM フェーズは実装者/エージェントが生成。脆弱性は `scripts/scan_dependency_vulns.ts`（pnpm audit/outdated、自リポジトリ対象）。鍵は `secret-actuator`（macOS Keychain・参照のみ、AWS KMS ではない）。版は `libs/core/sdlc-artifact-store.ts`(bumpVersion) + `artifact-actuator` 台帳。外部成果物の SBOM 生成を決定化する場合は syft/cyclonedx バイナリを `system:exec` で呼ぶステップを追加する（拡張ポイント）。

## 2. IT運用自動化 (`it-operations-automation`)

監視・検知 → 診断 → 変更計画(CAB) → **AWSシミュレーション** → 自動実行(承認) → 検証 → 運用台帳記録。実行前に必ず副作用なしのシミュレーションで影響評価する。

| フェーズ            | 種別          | ゲート                       | 会議体/備考                      |
| ------------------- | ------------- | ---------------------------- | -------------------------------- |
| 監視・検知          | judgment      | `SIGNAL_TRIAGED`             | —                                |
| 診断                | judgment      | `DIAGNOSIS_DONE`             | —                                |
| 変更計画            | judgment      | `CHANGE_APPROVED` (+人間)    | 変更諮問会議(CAB)                |
| （preflight）       | gate          | —                            | —                                |
| AWSシミュレーション | deterministic | `SIMULATION_PASSED`          | `aws-operations-simulation.json` |
| 自動実行            | approval      | `EXECUTION_APPROVED` (+人間) | シミュレーション判定を承認後     |
| 検証                | deterministic | `OPS_VERIFIED`               | 目標状態収束・副作用なし         |
| 運用台帳記録        | deterministic | `OPS_RECORDED`               | 学び・自動化改善を起票           |

## 3. AWSシミュレーション (`pipelines/aws-operations-simulation.json`)

変更計画を入力に、**実 AWS リソースに一切触れず**に terraform plan / CloudFormation change-set / aws-cli `--dry-run` 相当の実行トレースを生成する決定的パイプライン。`system:log → system:read_file → reasoning:synthesize → system:write_file → system:log`。出力 JSON:

```
{ summary, target_environment, planned_changes[{service,action,resource,details}],
  iam_permission_checks[{principal,action,verdict}], blast_radius{scope,affected_resources,risk},
  preconditions[{check,status}], rollback_plan[], verdict, conditions[] }
```

`verdict` は `safe-to-apply` / `apply-with-conditions` / `blocked`。実 AWS 適用が必要な場合は、`system:exec` で `aws ... --dry-run`(`allow_error:true`, `export_as`) もしくは `service-actuator:cli` を使う別パイプラインを、承認・認証情報つきでサンドボックス外に用意する（本シミュレーションは認証情報不要・副作用ゼロ）。

実行例:

```bash
pnpm pipeline --input pipelines/aws-operations-simulation.json \
  --context '{"change_plan_path":"active/shared/tmp/change-plan.json","output_path":"active/shared/tmp/aws-simulation-report.json"}'
```

## 4. 動的ワークフロー登録 (`scripts/register_workflow.ts`)

**設計思想**: kyberion のカタログはすべて手編集JSON + `pnpm validate` 検証。ランタイム自己書き換えはガバナンスモデルに反するため、本ツールは「コンパクトな登録リクエスト → スキーマ検証 → カタログ準拠エントリへ展開 →（提案 or 適用）→ バリデータでゲート」という、確立された _提案→検証マージ_ パターンを自動化する。

- **入力**: `schemas/workflow-registration-request.schema.json` 準拠のリクエスト JSON（workflow_id・mission_class・risk_profile・team_template・intent・phases[{id,title,kind,gate_id,checks,...}] など）。
- **展開先**: mission-workflow-catalog（intake/classification/preflight を自動足場化、各フェーズに exit_gate を必ず付与）・standard-intents・intent-domain-ontology・intent-routing-map（+任意で gate-profile-registry / governance-body-registry）。
- **モード**:
  - `--propose`（既定）: `active/shared/tmp/workflow-registration-proposals/<id>/` にマージ可能なバンドル + `MERGE_INSTRUCTIONS.md` を書く（governed 書き込みなし）。
  - `--apply`: 4カタログへ id 冪等でマージ（secure-io + authority role `register_workflow`、`security-policy.json` に allow_write を付与済み）。実行後にバリデータで必ずゲートする。

```bash
# 提案(安全) → レビュー → マージ or 適用
node dist/scripts/register_workflow.js --request active/shared/tmp/my-workflow.json --propose
node dist/scripts/register_workflow.js --request active/shared/tmp/my-workflow.json --apply
# 適用後は必ず検証
pnpm run build && node dist/scripts/check_workflow_catalog_refs.js \
  && node dist/scripts/check_governance_rules.js \
  && node dist/scripts/check_intent_domain_coverage.js \
  && pnpm generate:knowledge-index
```

**登録セレモニー準拠**（`kyberion-development-practices.md`）: リクエスト読み込み/成果物書き込みは secure-io 経由、リクエストはプロジェクトルート配下に置く（外部パスは拒否される）、governed 書き込みは `register_workflow` ロールの narrow な allow_write のみ。ゲート必須ルール（default_tasks を持つフェーズは exit_gate 必須）・タスク説明の最小長などのバリデータ規則は展開時に満たすよう生成する。

> **ゲートの動的追加**: フェーズの `exit_gate.checks[]`（`evidence_exists`/`reviewer_approved`/`deliverable_quality`/`human_override`）は登録リクエストの `phases[].checks` から生成される。SDLC/インシデントの判断ゲートは `gate-profiles/gate-profile-registry.json`、会議体は `governance-body-registry.json` にリクエストの任意項目から追記できる。

→ 関連: [it-delivery-operations-governance.md](./it-delivery-operations-governance.md) · [security-audit-service.md](./security-audit-service.md) · `governance-body-registry.json` · `CAPABILITIES_GUIDE.md`
