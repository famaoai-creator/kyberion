# KP-03 知識スライス スキーマ設計ノート

> 作成日: 2026-07-25 / 設計: claude-opus / 実装引き継ぎ: claude-sonnet-4
> 対象: `knowledge/product/schemas/knowledge-slices.schema.json` + `knowledge/product/governance/knowledge-slices.json`

## マッチャ意味論

各 slice の `match` は `team_role` × `phase` × `mission_type` のセレクタ。フィールドを省略、または `"*"` を指定すると任意値にマッチ。`phase` は phases/ ディレクトリ準拠の enum(alignment/execution/onboarding/recovery/review)+ `"*"`。リクエスト(dispatch 時プロファイル)の各値と大文字小文字を区別して照合し、**宣言した全フィールドが一致した slice のみ**が「マッチ集合」に入る。

## 精度(specificity)と優先順位

specificity = `match` 内の非ワイルドカードフィールド数(0〜3)。同 specificity は**配列順(後勝ち)**を決定論的タイブレークとする。

## マージ挙動(ディレクティブ種別で異なる)

- `pinned` / `exclude`: マッチ集合全体を **union**(加算的)。→ 広いデフォルトの `exclude` は常に効く。
- `pinned` 並び順: **most-specific-first**(role/phase 固有 pin が先頭)、同順位は配列順、その後 path で dedup(先勝ち)。
- `search_roots`: **most-specific-wins(非マージ)**。search_roots を宣言する最も具体的な slice がリスト全体を供給。宣言が無ければ次に具体的な slice へフォールバック。

## パス検証ルール

すべて repo-relative POSIX・`knowledge/` 配下必須。`pinned` は具体ファイル(`.md`/`.json`、glob 不可)、`search_roots` は末尾 `/` のサブツリー接頭辞、`exclude` は `*` を許す glob。

## loadKnowledgeHintsIfPossible の消費順(実装者向け)

1. dispatch プロファイル(mission_type / team_role / phase)で slice を解決しマージ結果を得る。
2. `pinned` を先頭固定で配給。**pinned は hint/文字予算を最初に消費**(予約 → 残予算で検索)。pinned だけで予算超過なら末尾(最も非具体・後宣言)から逆順に drop — pin は優先主張であり予算免除ではない。
3. 残予算で `findRelevantDistilledKnowledge` を実行。`search_roots` で taxonomy.retrieval_priority の順序を上書き、`exclude` にマッチする path は候補から除外。
4. あわせて frontmatter `role_affinity`/`phase`/`applies_to` を `knowledgeMetadataScore()`(KM-02)信号へ追加(本設計の範囲外・別コミット)。

## 後方互換

マッチする slice が 1 つも無い場合はディレクティブ空 → **現行動作(一律 top-3 検索・除外なし)を維持**。ファイル自体が欠落/parse 失敗のときも fail-open(検索のみ)で配給を止めない。

## 実装者への未解決事項(open questions)

1. `phase` の dispatch 時ソース: `loadKnowledgeHintsIfPossible` は現状 phase を受けていない。work item/mission state から phase をどう供給するか要決定(供給できるまで phase は実質 `"*"` 扱い)。
2. `pinned` 本文の取得: distilled index ではなく生ファイルを読むため、抜粋長・secure-io 経由読取・不在時の扱いを実装で定義。
3. `exclude` の適用点: retrieval 内フィルタか、index 構築時の除外か(KP-07 の corpus 純度ガードと二重管理にしない)。
4. `mission_type` 語彙の正規化(delivery/development/operations/product_development)と team_role 語彙(team-roles/\*.json)の突合バリデーションを CI に載せるか。
