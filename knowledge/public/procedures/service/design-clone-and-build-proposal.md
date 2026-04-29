---
title: Design Clone And Build Proposal
category: Procedures
tags: [procedures, service, proposal, media, deck, presentation]
importance: 8
author: Kyberion
last_updated: 2026-03-21
---

# Design Clone And Build Proposal

対象依頼の典型形:

> この資料をベースに、こういったストーリーで提案書を作成して。必要な成果物も出力してください。

## Goal

既存資料の theme、tone、構成感を踏襲しながら、別の client / concept / story に合わせた提案書を生成し、設計資料と成果物パックまで出す。

## Current Feasibility

現時点の Kyberion では、これは高い実現性があります。

既存資産:

- `pptx_extract`
- `theme_from_pptx_design`
- `document_outline_from_brief`
- `brief_to_design_protocol`
- `generate_document`
- Media examples と theme catalog

## Input Contract

最低限ほしい入力:

1. 参照元資料
2. 踏襲したい design/tone
3. proposal brief
4. audience
5. 必須章立て
6. 出したい成果物

## Recommended Flow

1. source deck extract
2. theme distill
3. proposal brief 作成
4. profile-aware outline 生成
5. design protocol compile
6. binary render
7. 必要なら appendix / executive summary / evidence map 作成

## Core Contracts

- [`proposal-brief.schema.json`](/Users/famao/kyberion/knowledge/public/schemas/proposal-brief.schema.json)
- [`proposal-storyline-adf.schema.json`](/Users/famao/kyberion/knowledge/public/schemas/proposal-storyline-adf.schema.json)

## Media Example

- [`proposal-storyline-pptx.json`](/Users/famao/kyberion/libs/actuators/media-actuator/examples/proposal-storyline-pptx.json)

## Output Pack

- proposal deck
- proposal brief
- outline ADF
- design protocol
- supporting evidence summary
- optional executive memo
