---
title: SDLC Gating Model
category: Architecture
tags: [sdlc, gating, project-os, governance]
importance: 8
author: Kyberion
last_updated: 2026-03-29
---

# SDLC Gating Model

Kyberion の SDLC gate は、`文書を増やすこと` ではなく、`次の phase に進める判断を evidence 付きで行うこと` を目的とします。

`Project` と `SDLC` は 1:1 とは限りません。  
Kyberion では、gate は通常 `Project` ではなく `Track` にぶら下がります。

- `Project`
  - 長寿命の統制単位
  - charter / stakeholder / shared policy を持つ
- `Track`
  - delivery / change / release / incident などの実行線
  - requirements / design / validation / release artifacts と gate を持つ

## Core Rule

各 gate では次を明示します。

- 何を判断する gate か
- project scope か track scope か
- 誰が判断するか
- 何の artifacts が必要か
- どの exit criteria を満たす必要があるか
- 例外を誰が承認できるか

## Gate Sequence

1. `Initiation Approval`
- Why が正しいかを決める

2. `Requirements Baseline`
- What が十分に定義されているかを決める

3. `Design Approval`
- How が妥当かを決める

4. `Build Readiness`
- 実行統制が機能しているかを決める

5. `Validation Approval`
- できたと主張する根拠が揃っているかを決める

6. `Release Readiness`
- 本番移行と運用受け入れを許可するかを決める

7. `Closure Review`
- 学習と残課題処理を確認して閉じる

## Artifact Strategy

gate は単一文書ではなく、artifact bundle で成立します。

例:

- `Requirements Baseline`
  - scope: track
  - requirements-definition
  - requirements-traceability-matrix
  - slo-sli-definition
  - information-asset-registry

- `Release Readiness`
  - scope: track
  - release-readiness-checklist
  - cutover-migration-plan
  - rollback-plan
  - deployment-verification-report
  - operation-runbook

- `Initiation Approval`
  - scope: project
  - project-charter
  - business-impact-analysis
  - stakeholder-communication-register

## Control Principles

- `Gate Review Packet` は gate 全体の要約と判断記録
- `Traceability Matrix` は要件と設計・テスト・不具合の結節点
- `Compliance Control Matrix` は規制や社内統制を実装・運用・証跡に結ぶ
- `Release Readiness Checklist` は go / no-go の判断面
- `Rollback Plan` と `Deployment Verification Report` は release gate の両輪

## Relationship To Missions

`Project` は shared governance の単位です。  
`Track` は gate 判断の主単位です。  
`Mission` は gate を前に進める execution unit です。

つまり:

- Project
  - shared charter / stakeholder / communication artifacts を持つ
- Track
  - gate と artifact bundle を持つ
- Mission
  - 各 artifact の作成・改修・検証を進める
- Mission Ledger
  - どの mission がどの project / track / gate / artifact に影響したかを結ぶ

## Recommendation

実運用では、各 phase ごとに次の 3 つを固定すると運用しやすくなります。

- required artifacts
- exit criteria
- decision owner

この 3 点が曖昧な gate は、判断会議ではなく単なるレビュー会になります。
