# Project Operating System

プロジェクト文書を `文書種類の寄せ集め` ではなく、`意思決定・実装・検証・運用を前に進める Operating System` として束ねるための上位概念です。

対象文書の例:

- プロジェクト憲章
- プロジェクトマネジメント計画書
- 要件定義書
- 基本設計書
- 詳細設計書
- 運用設計書
- テスト結果報告書
- ゲーティング資料
- 要件トレーサビリティマトリクス
- リリース判定チェックリスト
- ロールバック計画
- デプロイ確認報告
- コンプライアンス統制マトリクス

## Core Concept

文書体系は 2 軸で整理します。

1. `Lifecycle`
- Initiate
- Define
- Design
- Build
- Validate
- Transfer / Run

2. `Control Layer`
- Why
- What
- How
- Control
- Evidence

この 2 軸で見ると、各文書の役割が明確になります。

ただし、`Project = 1 SDLC` と固定しません。  
Project は長寿命の統制単位で、その下に複数の `Track` を持てます。

- `Project`
  - charter, stakeholder, communication などの共有統制
- `Track`
  - requirements, design, validation, release の実行線

## Five Control Layers

### 1. Why

project の存在理由と成功条件を定義する層です。

代表文書:

- [`project-charter.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/project-charter.md)
- [`business-impact-analysis.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/business-impact-analysis.md)
- [`stakeholder-communication-register.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/stakeholder-communication-register.md)

### 2. What

track ごとに、何を作るか、何を満たすべきかを定義する層です。

代表文書:

- [`requirements-definition.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/requirements-definition.md)
- [`requirements-traceability-matrix.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/requirements-traceability-matrix.md)
- [`slo-sli-definition.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/slo-sli-definition.md)
- [`information-asset-registry.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/information-asset-registry.md)

### 3. How

track ごとに、どう作るか、どう動かすかを定義する層です。

代表文書:

- [`basic-design.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/basic-design.md)
- [`architecture-design.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/architecture-design.md)
- [`detailed-design.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/detailed-design.md)
- [`operational-design.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/operational-design.md)
- [`operation-runbook.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/operation-runbook.md)
- [`data-flow-lifecycle-map.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/data-flow-lifecycle-map.md)
- [`environment-setup-guide.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/environment-setup-guide.md)
- [`compliance-control-matrix.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/compliance-control-matrix.md)

### 4. Control

進行管理、意思決定、変更統制、品質統制を担う層です。  
この層は project 共通の control と、track ごとの execution control が混在します。

代表文書:

- [`project-management-plan.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/project-management-plan.md)
- [`mission-ledger.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/mission-ledger.md)
- [`raid-log.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/raid-log.md)
- [`issue-log.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/issue-log.md)
- [`change-control-ledger.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/change-control-ledger.md)
- [`gate-review-packet.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/gate-review-packet.md)

### 5. Evidence

track ごとに、本当にできたか、出荷してよいかを証明する層です。

代表文書:

- [`test-plan.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/test-plan.md)
- [`test-case-specification.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/test-case-specification.md)
- [`test-validation-report.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/test-validation-report.md)
- [`security-audit-report.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/security-audit-report.md)
- [`release-readiness-checklist.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/release-readiness-checklist.md)
- [`rollback-plan.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/rollback-plan.md)
- [`deployment-verification-report.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/deployment-verification-report.md)
- [`incident-report.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/incident-report.md)
- [`mission-closure-report.md`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/blueprints/mission-closure-report.md)

## Lifecycle View

### Initiate

目的:

- なぜやるか
- 誰が意思決定するか
- 何を成功とみなすか

scope:

- `project`

必須成果物:

- Project Charter
- Business Impact Analysis
- Stakeholder Communication Register

### Define

目的:

- 何を作るか
- 何を受け入れ条件とするか

scope:

- `track`

必須成果物:

- Requirements Definition
- Requirements Traceability Matrix
- SLO/SLI Definition
- Information Asset Registry

### Design

目的:

- どう実現するか
- どう運用するか

scope:

- `track`

必須成果物:

- Basic Design
- Architecture Design
- Detailed Design
- Operational Design
- Data Flow & Lifecycle Map
- Operation Runbook
- Environment Setup Guide
- Compliance Control Matrix

### Build

目的:

- 実装を統制された形で進める

scope:

- `track`

必須成果物:

- Project Management Plan
- Mission Ledger
- RAID Log
- Issue Log
- Change Control Ledger

### Validate

目的:

- できたことを証明し、リリース可否を判断する

scope:

- `track`

必須成果物:

- Test Plan
- Test Case Specification
- Requirements Traceability Matrix
- Test Validation Report
- Security Audit Report
- Gate Review Material

### Transfer / Run

目的:

- 運用へ安全に引き継ぎ、改善を継続する

scope:

- `track`

必須成果物:

- Release Readiness Checklist
- Cutover / Migration Plan
- Rollback Plan
- Deployment Verification Report
- Operation Runbook
- User Manual / FAQ
- Incident Report
- Post-Mortem
- Mission Closure Report

## Dependency Model

依存関係は次の順です。

1. Charter
2. Requirements
3. Architecture
4. Detailed Design / Runbook
5. PM Control Documents
6. Test Design / Validation
7. Gate Review
8. Transfer / Closure

重要なのは、`テスト結果報告書` を単独文書にしないことです。
必ず

- 要件
- 設計
- 実行証跡
- gate 判断

と紐づいている必要があります。

同じく、`リリース判定` も単独会議にしません。必ず

- requirements-traceability-matrix
- compliance-control-matrix
- release-readiness-checklist
- rollback-plan
- deployment-verification-report

と結びます。

同じ考え方で、`Mission` も `Project` や `Track` と同一視しません。整合は project / track 側の ledger と、mission 側の relationship で持ちます。

- `Project`
  - 長寿命の統制単位
  - 憲章、共有方針、stakeholder 文書を持つ
- `Track`
  - project 配下の delivery / change / release / incident 線
  - 要件、設計、validation、release gate を持つ
- `Mission`
  - 短寿命の実行単位
  - 改修、調査、提案、検証、障害対応などを担う
- `Mission Ledger`
  - 両者を結ぶ台帳
  - どの mission がどの project / track / artifacts / gate に影響したかを記録する

推奨関係種別:

- `belongs_to`
- `supports`
- `governs`
- `independent`

## SDLC Gates

Project Operating System では、各 phase の終わりに gate を置きます。  
通常、`Initiation Approval` は project scope、それ以降は track scope です。

1. `Initiation Approval`
- Project Charter と Business Impact Analysis を承認する

2. `Requirements Baseline`
- Requirements Definition と Traceability Matrix を baseline 化する

3. `Design Approval`
- Architecture / Detailed / Operational Design と Control Matrix を承認する

4. `Build Readiness`
- PM / Mission / Change の control artifacts が稼働していることを確認する

5. `Validation Approval`
- Test, Security, Traceability, Gate Packet を揃えて release candidate を評価する

6. `Release Readiness`
- Release Checklist, Cutover, Rollback, Deployment Verification を揃えて go / no-go を決める

7. `Closure Review`
- Incident / Post-Mortem / Closure Report で学習を固定する

gate 詳細は [`sdlc-gating-model.md`](/Users/famao/kyberion/knowledge/public/architecture/sdlc-gating-model.md) と [`sdlc-gate-catalog.json`](/Users/famao/kyberion/knowledge/public/governance/sdlc-gate-catalog.json) を参照します。

## Recommended Directory Structure

```text
project-os/
  01_initiate/
    project-charter.md
    business-impact-analysis.md
    stakeholder-communication-register.md
  tracks/
    TRK-release-1/
      02_define/
        requirements-definition.md
        requirements-traceability-matrix.md
        slo-sli-definition.md
        information-asset-registry.md
      03_design/
        basic-design.md
        architecture-design.md
        detailed-design.md
        operational-design.md
        data-flow-lifecycle-map.md
        operation-runbook.md
        environment-setup-guide.md
        compliance-control-matrix.md
      04_control/
        project-management-plan.md
        mission-ledger.md
        raid-log.md
        issue-log.md
        change-control-ledger.md
        gate-review-packet.md
      05_validate/
        test-plan.md
        test-case-specification.md
        test-validation-report.md
        security-audit-report.md
        evidence/
      06_transfer_run/
        release-readiness-checklist.md
        cutover-migration-plan.md
        rollback-plan.md
        deployment-verification-report.md
        user-manual-faq.md
        post-mortem.md
        incident-report.md
        mission-closure-report.md
```

## Gating Concept

ゲート資料は独立した 1 文書ではなく、`Control` と `Evidence` を束ねる review packet と考えるのが良いです。

含めるもの:

- 対象フェーズの exit criteria
- 未解決論点
- リスク一覧
- テスト結果要約
- 承認者
- Go / Conditional Go / No-Go

## Kyberion Positioning

Kyberion では、この体系を `Project Operating System` として扱うのが自然です。

理由:

- PM 文書
- 設計文書
- 品質文書
- 運用文書
- 証跡

を単一の概念で束ねられるからです。

## Recommended Next Step

実運用では次の順が良いです。

1. プロジェクトごとの `project-os/` 雛形を作る
2. blueprint から各文書を instantiate する
3. mission の影響は `mission-ledger.md` に集約する
4. 各文書間の traceability を付ける
5. gate review packet を phase ごとに標準化する

CLI scaffold:

```bash
pnpm project-os:init --name "Sample Project"
pnpm project-os:init --name "Sample Project" --out active/projects/sample-project/project-os
```
