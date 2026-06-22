---
title: Text Review And Approval Flow
category: Procedures
tags: [procedures, review, approval, text, document, governance]
importance: 8
author: Kyberion
last_updated: 2026-06-22
---

# Text Review And Approval Flow

## Goal

「この文章をレビューして」という依頼を、単なる読後感ではなく、入力の型・レビュー目的・役割境界に基づいて処理する。

## Core Idea

最初にやることは内容レビューではなく、**レビュー対象が何の形式で書かれているかを判定すること**です。

契約・仕様・正式文書は `contract-review` に寄せ、一般文章・案内文・Markdown は `review-text` に寄せます。

その後で、

1. ソース種別を正規化する
2. レビュー目的を把握する
3. 役割・テナント・承認境界に応じた観点を選ぶ
4. その観点に沿ってレビューする

という順で進めます。

## Recommended Flow

### 1. Source Type Detection

まず入力を分類します。

| Source kind | Normalization path | Notes |
|---|---|---|
| `pdf` / `docx` / `pptx` / `xlsx` | `media:document_digest` | まず LLM が読める markdown へ正規化する |
| `txt` / `md` | direct text read / plaintext normalization | 文字列そのものがレビュー対象になる |
| `html` / URL | browser capture → text extraction | 見た目の文面と DOM 上の文面を分けて扱う |
| code / config / policy | code review route | 文書レビューではなく実装レビューに寄せる |
| unknown | clarification | ファイル種別と目的を先に確認する |

### 2. Review Purpose Detection

ソースが読めても、レビュー目的が違うと観点が変わります。

| Review purpose | What to check |
|---|---|
| Approval / sign-off | 誰が承認すべきか、承認の前提が揃っているか |
| Contract / spec | 仕様の曖昧さ、責任範囲、抜け漏れ |
| Content quality | 論理、構成、読みやすさ、冗長性 |
| Risk / compliance | 法務、セキュリティ、炎上、誤解、情報漏えい |
| Role fit | その文面が自分のテナント・権限・役割で出してよいか |
| Incident-aware | 既知障害や過去の失敗パターンに引っかからないか |

### 3. Persona / Tenant / Role Lens

レビュー依頼が自分に来る理由は、単に「読めるから」ではなく、役割に基づく責任を持っているからです。

以下の lens を最初に明示すると、レビューの意味がぶれにくくなります。

| Lens | What it means |
|---|---|
| Self persona | 自分の立場で、その文面を出して問題ないか |
| Tenant scope | そのテナントの文脈で、他テナントへ漏れていないか |
| Authority boundary | その役割に承認権限があるか、越権していないか |
| Approval chain | どの承認者に回すべきか、先に止めるべきか |
| Audience fit | 想定読者に対して表現が強すぎないか、弱すぎないか |

### 4. Review Execution

レビュー実行では、少なくとも次を返します。

- 問題点
- 重大度
- 直すべき箇所
- 代替文案
- 承認可否の観点
- 役割/テナント/権限に基づく注意点

## Flow Candidates by Source Kind

### A. Plain Text / Markdown

1. raw text をそのまま取り込む
2. review purpose を確認する
3. persona / tenant / role lens を選ぶ
4. 内容レビューを実施する

適したケース:

- メール本文
- Slack 投稿案
- README
- 契約前の説明文

### B. Office Documents

1. `media:document_digest` で markdown 化する
2. 元の構造を保持したままレビューする
3. 必要なら再生成用の修正文案も返す

適したケース:

- PDF
- DOCX
- PPTX
- XLSX

### C. HTML / Web Copy

1. browser でページを確認する
2. 見えている文面と DOM の文面を分ける
3. コピーの文面をレビューする
4. 表示ズレや CTA の誤解も合わせて確認する

### D. Approval-Critical Review

1. 誰の承認が必要かを確認する
2. 自分の役割で判断してよい範囲を確認する
3. 越権の可能性があれば明示する
4. 必要なら人間レビューへエスカレーションする

## Output Contract

レビュー結果は、少なくとも次の形にする。

```text
review summary
source kind
review purpose
persona / tenant / role lens
findings
rewrite suggestions
approval recommendation
escalation needed or not
```

## Intent Expressions

- `この文章をレビューして`
- `この文面を承認前提で見て`
- `この契約文書を法務観点でレビューして`
- `この案内文を役割に応じてチェックして`
- `この文章を人間レビューに回すべきか判断して`

## Related Flows

- `contract-review` pipeline
- `review-text` pipeline
- `review-worker-output`
- `incident-informed-review`
- `active-learning-escalate`
- `adaptive-reasoning`
