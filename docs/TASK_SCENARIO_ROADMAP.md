---
title: Task Scenario Roadmap
category: Product
tags: [taskscenario, roadmap, automation, operations]
importance: 6
last_updated: 2026-07-13
---

# Task Scenario Roadmap

この文書は、Kyberion の `TaskScenario` レイヤーを「業務成果物」単位で使うための実装ロードマップです。

`USE_CASES.md` は引き続き広い自動化カタログの canonical source です。
このロードマップは、その上に重ねる repeatable task の入口をまとめます。

## 目的

- 初回だけ軽い推論と条件確認を行う
- 以後は保存済み profile と pipeline-template で反復実行する
- 送信や承認の境界を approval boundary で明示する

## Quickstart

この短い手順は、コピーしてすぐ動かしたい人向けです。

- [TaskScenario Quickstart](./TASK_SCENARIO_QUICKSTART.md)

## Current flow

1. Discover available tasks with `pnpm task:list`.
2. Initialize a saved profile with `pnpm task:init <task-id> --answers-json '<json>'`.
3. Review the dry-run plan with `pnpm task:run <task-id> --dry-run`.

## 初期シナリオ

### 1. `daily-email-triage`

- User phrase example: `毎朝メールを整理して`
- Business outcome: 重要メールの抽出、要約、返信下書きの作成
- Input sources: Gmail
- First-run reasoning / setup questions: 重要判定の条件、返信下書きの許容範囲、送信前の人間承認条件
- Repeat-run behavior: 保存済み profile を読み、朝の triage を定型実行する
- Output artifacts: `email-triage.md`, `reply-drafts.json`
- Approval boundary: `send_email` は要承認、既定は `draft-only`
- Existing pipeline-template: `knowledge/product/pipeline-templates/email-triage-workflow.json`
- Implementation status: scenario + workflow + CLI profile path を追加済み

### 2. `meeting-action-items`

- User phrase example: `会議が終わったらTODOをまとめて`
- Business outcome: 会議 transcript から action item を抽出して次アクションを整える
- Input sources: meeting transcript, notes, attendee list
- First-run reasoning / setup questions: 何を action item とみなすか、責任者と期限の扱い、共有先
- Repeat-run behavior: 会議終了イベント後に postprocess を回し、抽出結果を保存する
- Output artifacts: `action-items.json`, `follow-up-summary.md`
- Approval boundary: 外部共有前の要約編集は要確認、既定は `notify-only`
- Existing pipeline-template: `knowledge/product/pipeline-templates/meeting-facilitation-postprocess.json`
- Implementation status: scenario + workflow MVP を追加済み

### 3. `meeting-to-proposal-pptx`

- User phrase example: `商談メモから提案資料を作って`
- Business outcome: 会議メモから提案書デッキを生成する
- Input sources: meeting notes, client context, deck preference profile
- First-run reasoning / setup questions: デッキの目的、対象読者、ブランド適用、修正許容範囲
- Repeat-run behavior: profile 化された deck preference を使って同じ構成で生成する
- Output artifacts: `proposal-deck.pptx`, `deck-brief.json`
- Approval boundary: 顧客送付前の編集、外部共有、最終送信は要承認
- Existing pipeline-template: `knowledge/product/pipeline-templates/meeting-to-pptx-workflow.json`
- Implementation status: TaskScenario contract を追加済み

### 4. `sales-inbound-response`

- User phrase example: `問い合わせが来たら見込み度と返信案を作って`
- Business outcome: インバウンド問い合わせを分類し、見込み度と返信下書きを作る
- Input sources: inquiry text, account context, solution hints
- First-run reasoning / setup questions: 見込み判定基準、返信トーン、提案してよい範囲
- Repeat-run behavior: profile に基づいて lead scoring と提案ドラフトを定型実行する
- Output artifacts: `lead-score.json`, `proposal-draft.md`, `reply-draft.md`
- Approval boundary: 外部送信と提案の最終化は要承認、既定は `draft-only`
- Existing pipeline-template: `knowledge/product/pipeline-templates/sales-inbound-lead-workflow.json`
- Implementation status: workflow は既存。repeatable task の profile 化が必要

### 5. `weekly-executive-digest`

- User phrase example: `毎週月曜に経営・PJダイジェストを作って`
- Business outcome: 経営・プロジェクトの要点を週次でまとめる
- Input sources: project updates, alerts, milestones, review notes
- First-run reasoning / setup questions: 重要指標、強調順、受け手別の粒度、非公開情報の扱い
- Repeat-run behavior: 毎週月曜に profile ベースで要約を生成し、同じフォーマットで配信準備する
- Output artifacts: `weekly-digest.md`, `digest-brief.json`
- Approval boundary: 配信前の公開範囲確認は要承認、既定は `notify-only`
- Existing pipeline-template: `knowledge/product/pipeline-templates/weekly-executive-digest.json`
- Implementation status: scenario + workflow MVP を追加済み

## 次の実装順

1. `TaskScenario` schema と example
2. `docs/SCENARIO_CATALOG.md` へのリンク追加
3. `pnpm task:list` の追加
4. `pnpm task:init` の追加
5. `pnpm task:run` の追加

# Marketing Workload Track

- Available: domain contract, risk policy, claim/review/approval binding, completion evidence evaluation.
- Available: local video package, publication review, and YouTube dry-run ADF templates.
- Available: customer policy, brand, design token, and marketing Mission seed templates.
- Next: governed production connectors for YouTube/CMS/social, ffprobe-based media inspection, PII/secret scanning, screenshots, analytics ingestion, and UI.

# Cross-tool Productivity Track

- Available: deterministic planning across calendar, meeting, email, document, presentation, browser, and connected-system domains.
- Available: effect classification (`read`, `draft`, `external_write`, `financial_commit`) with explicit missing-input and approval boundaries.
- Available: `pnpm cli -- task plan` for read-only previews and `pnpm cli -- task start` for governed Task Session creation.
- Available: `productivity-task-orchestration.json` dry-run template that emits a review package and receipt with no external effects or network access.
- Next: bind calendar mutation, meeting participation, email delivery, and browser checkout executors to authenticated approval records and effect payload hashes.
- Next: add customer-overlay defaults for preferred calendars, meeting providers, service bindings, document themes, and payment limits.
