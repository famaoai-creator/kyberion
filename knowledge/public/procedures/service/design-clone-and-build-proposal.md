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
- `pptx-theme-pack.schema.json`
- `web-theme-pack.schema.json`
- `document_outline_from_brief`
- `brief_to_design_protocol`
- `generate_document`
- Media examples と theme catalog

`pptx_extract` / `xlsx_extract` は raw-preserving で、抽出後の protocol から同じデザイン再現に必要な情報を残します。clone/rebuild 系のフローでは、ここを source of truth にしてください。

PPTX をそのままテーマ登録する場合は、`pptx-theme-pack` として次の情報を一緒に保存します。

- 色とフォント
- ロゴ
- `canvas`
- `master`
- raw theme / master / layout XML
- 再利用する `layout_templates`

この形にしておくと、表紙・タイトル・ロゴ・マスター差分が theme 単体よりもズレにくくなります。

Web サイトを同様に登録する場合は、次の流れにします。

1. `browser:open_tab`
2. `browser:snapshot`
3. `reasoning:synthesize`
4. `media:save_brand_to_confidential`
5. `build-web-concept`

このときの `web-theme-pack` は、パレットとフォントに加えて hero 構造、spacing scale、layout grid、breakpoints、HTML の再構成に使う骨格情報を持たせます。

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

## Process Clarification Draft

PPTX と Web は「見た目を真似る」対象ではなく、「再構成に必要なデザイン契約を抽出して登録する」対象として扱います。

### PPTX の流れ

1. source pptx を解析する
2. theme / master / layout / logo / canvas を分離する
3. `pptx-theme-pack` として保存する
4. 必要なら `brief_to_design_protocol` で別テーマへ再適用する
5. 再生成後に表紙、タイトル、会社ロゴ、マスター反映の差分を確認する

### Web の流れ

1. source URL を開く
2. browser snapshot から配色、タイポグラフィ、spacing、grid、breakpoints、hero 構造を抽出する
3. `web-theme-pack` として保存する
4. `build-web-concept` で同じ骨格を再利用する
5. 再生成後にファーストビュー、セクション構成、余白、ロゴ配置の差分を確認する

### 共通の判定基準

- source の単なる再掲ではなく、別 brief に移植できること
- token 単位だけでなく、レイアウト骨格まで残すこと
- registry に保存した後、別の生成フローから再利用できること
- 画像や色が一致しても、配置や階層が壊れていれば未完了とみなすこと

## Core Contracts

- [`proposal-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/proposal-brief.schema.json)
- [`proposal-storyline-adf.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/proposal-storyline-adf.schema.json)

## Media Example

- [`proposal-storyline-pptx.json`](/Users/famao/kyberion/libs/actuators/media-actuator/examples/proposal-storyline-pptx.json)

## Output Pack

- proposal deck
- proposal brief
- outline ADF
- design protocol
- supporting evidence summary
- optional executive memo

## Intent Expression Candidates

現時点の標準候補は `extract-brand-theme` と `build-web-concept` です。

### 既存の標準 intent

- `extract-brand-theme`
  - 既存の PPTX / Web 由来の見た目を theme pack 化する入口
  - 利用者向け表現例
    - 「この資料のデザインをテーマ登録して」
    - 「このWebサイトの見た目を再利用できる形にして」
    - 「このブランドを PPTX と Web 両方で使えるテーマにして」
- `build-web-concept`
  - 既存の brief と design theme を使って Web を再構成する入口
  - 利用者向け表現例
    - 「このテーマでWebサイトを作って」
    - 「この資料のデザインをWebに落として」
    - 「このブランドのルールを保ったLPを作って」

### 入力別の候補表現

PPTX 由来:

- 「この PowerPoint をテーマ化して」
- 「表紙・タイトル・ロゴ込みで再利用できるテーマにして」
- 「マスターとレイアウトも含めて登録して」

Web 由来:

- 「このWebサイトをテーマ化して」
- 「ヘッダー、hero、余白、フォントまで再利用できる形にして」
- 「同じ雰囲気で別ページを作れるようにして」

### 将来の補助 intent 候補

必要なら、利用者の言い回しをもっと明確にするために次の補助 intent を追加できます。

- `import-brand-from-pptx`
  - PPTX 取り込みに明示的に寄せる
- `import-brand-from-html`
  - Web 取り込みに明示的に寄せる
- `register-design-theme-pack`
  - 取り込み結果を登録する行為を明示する

ただし、運用上は intent を増やしすぎず、`extract-brand-theme` を入口として内部で source type を分岐させるほうが安定です。
