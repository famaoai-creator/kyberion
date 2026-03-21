---
title: Blueprint: Mission Ledger
category: Templates
tags: [templates, blueprints, project, mission, traceability]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-21
---

# Blueprint: Mission Ledger
<!-- Owner: PM / PMO / Delivery Lead -->
<!-- Visibility: [L2: MANAGEMENT, L3: DELIVERY] -->

## 1. Purpose

この台帳は、`Project Operating System` と個別 `Mission` の関係を追跡するための統制文書です。

- ミッションがプロジェクト成果物にどう関与するか
- どの gate に影響するか
- どの文書へ trace すべきか

を一元的に管理します。

## 2. Operating Rule

- `Mission` は `Project` と同一ではない
- すべての mission は以下いずれかの関係種別を持つ
  - `belongs_to`
  - `supports`
  - `governs`
  - `independent`

## 3. Ledger

| Mission ID | Relationship | Status | Summary | Affected Artifacts | Gate Impact | Traceability Refs |
|---|---|---|---|---|---|---|
| [INPUT: mission_id] | [INPUT: belongs_to/supports/governs/independent] | [INPUT: active/completed/etc.] | [INPUT: short summary] | [INPUT: charter, requirements, gate-review-packet, etc.] | [INPUT: none/informational/review_required/blocking] | [INPUT: file refs, issue ids, evidence refs] |

## 4. Review Cadence

- Gate review 前に更新
- 主要成果物変更時に更新
- Mission close 時に最終反映
