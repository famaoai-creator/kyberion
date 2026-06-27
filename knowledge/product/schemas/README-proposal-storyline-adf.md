# Proposal Storyline ADF

`proposal-storyline-adf.schema.json` は、提案書の章立てと各 slide の主張を表す中立 contract です。

想定用途:

- brief から storyline を生成する
- storyline から PPTX/DOCX を render する
- review と traceability を分離する

`diagnostics` には、汎用レイアウトの残数、長すぎる見出し、パターン不整合などの短い診断を入れます。生成直後に見た目の手戻りを減らすための補助情報です。
