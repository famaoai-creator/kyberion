# DS-02: テナントブランディングの全面適用 — PPTX 限定から Web/動画へ

> 優先度: P1 / 規模: M / 依存: DS-01(正準トークン) / 関連: [VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN](../VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN.ja.md) の未了項目 **VDS-07** を本計画が引き取る

## 背景と課題

テナント(顧客)ブランド適用の仕組みは **PPTX/メディア経路には既に本格実装がある**のに、Web と動画はそれを一切使えない。

- **実装済み(メディア経路)**: `knowledge/confidential/<tenant>/design/tenant-override.json`(`design_system_id`・brand_name matchers・`layout_template_catalog`・`branding{logo_url, palette_ref}`。例: sbiss)と full theme pack(例: `knowledge/confidential/sbijsm/design/theme.json` — Meiryo UI・`#4472C4`・master elements)。ランタイム解決は `media-actuator/src/index.ts:324`(`resolveConfidentialTenantOverride`)、`:354-366`(レイアウト優先順位)、`:404`(ロゴ)、さらに `brand_import` op(`:1613-1759`)が**ブランドキットの自動オンボーディング**まで持つ。検証レプリカ `scripts/verify-design-resolution.mjs:20-81`。
- **未接続(Web)**: chronos は常に `DEFAULT_CHRONOS_WEB_THEME_PACK` を使い(`web-design-system.ts:196` → `page.tsx:376`)、テナント文脈でダッシュボードを開いても Kyberion 標準のまま。operator-surface 等は DS-01 以前の状態。
- **未接続(動画)**: VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN の VDS-01/02/03/04/05/06/08 は完了済み(css_vars の配管、PPTX への `resolveThemeColors()` ブリッジ `media-actuator/src/index.ts:1397-1417` を含む)が、**VDS-07「外部プロファイルから実際の theme pack を選択する resolver」が未実装**。動画は常に既定トークンで生成される。
- `customer/{slug}/` は運用アイデンティティのみで視覚ブランドは `knowledge/confidential/<slug>/design/` にある — この分離は正しいので維持する。

## ゴール(受入条件)

1. **共有テナント・デザイン解決層**が `libs/core` に 1 つでき、`tenant/customer 文脈 → 正準トークン(DS-01)のオーバーライド` を返す。media-actuator の既存解決ロジックはこれを使う形にリファクタされる(挙動不変)。
2. chronos-mirror-v2 がテナント文脈(表示中の mission/customer)に応じて css_vars を切り替えられる(既定はKyberion 標準。テナント文脈が確定している画面のみ切替)。
3. 動画生成(VDS-07)が同じ解決層から theme pack を取得し、テナントブランドの動画が生成できる。
4. **tier 隔離が保たれる**: confidential のブランド値が public 成果物・公開 UI に漏れる経路がないことがテストで固定される(ブランド適用は当該テナントの文脈内のみ)。

## 実装タスク

### Task 1: 共有解決層の抽出 — `claude-sonnet-4`

1. `media-actuator/src/index.ts:324,354-366,404` の解決ロジックを `libs/core/tenant-design-resolver.ts` に抽出する: `resolveTenantDesign({ customerId?, brandName?, designSystemId? }): { tokens: 正準トークン部分集合, layoutCatalog?, logoPath?, source: 'tenant'|'default' }`。読み込みは secure-io 経由、confidential tier のパス解決は既存の customerResolver / tier-guard に従う。
2. media-actuator を新層の呼び出しに置換し、`scripts/verify-design-resolution.mjs` と既存テストで挙動不変を確認する(このレプリカスクリプトも新層を呼ぶ形にして二重実装を解消)。
3. unit test: tenant あり/なし/matchers 不一致/palette_ref 欠落。

### Task 2: Web への適用(chronos)— `claude-sonnet-4`

1. chronos のサーバ側(App Router の layout/route)でテナント文脈を確定できる箇所を特定し(mission 詳細・customer ビュー等)、`resolveTenantDesign` の結果を `webThemePackToCssVars` に合成して該当ページの css_vars として注入する。**グローバル切替はしない**(操作者が今どのテナント文脈にいるかが曖昧になるため。POST_ONBOARDING_UX_ROADMAP のテナントバナー構想と整合させ、切替時はバナー表示)。
2. confidential 由来の値がテナント文脈外のページ・共有キャッシュに残らないこと(css_vars の注入がリクエストスコープであること)をテストで固定する。
3. スクリーンショット(標準/テナント適用)を PR/パッチ説明に添付。

### Task 3: 動画への適用(VDS-07 の実装)— `claude-sonnet-4`

1. video-content-brief に `design_profile`(tenant/brand 指定)を追加し、storyboard 生成時に `resolveTenantDesign` → theme pack → 既存の css_vars 配管(VDS-01/02)へ流す。
2. VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN の VDS-07 項に「DS-02 Task 3 として実装」とステータス追記する(計画の重複を防ぐ)。
3. E2E: sbijsm theme.json を使ったテスト brief で、生成 ADF に tenant palette が載ることを確認(レンダリングまでは不要、ADF 検証で可)。

### Task 4: tier 隔離テスト — `claude-sonnet-4`

- 「public tier の成果物生成(テナント文脈なし)で confidential palette が参照されない」「テナント A 文脈の解決結果がテナント B に流用されない(キャッシュ分離)」の 2 点を `tests/` の境界テスト群に追加する。

### Task 5: ドキュメント — `claude-haiku`

- `DESIGN_SYSTEM.md`(DS-01 Task 5)にテナントブランディングの節を追加: override の置き場所、brand_import op の使い方、web/動画への適用条件。sbiss/sbijsm の実例は**参照パスのみ**記載(内容は confidential のため転記しない)。

## リスクと注意

- **tier 隔離が最大のリスク**。ブランド値(色・ロゴ)は confidential 情報であり、公開 UI・public 成果物・スクリーンショット付き PR に混入させない。Task 2/4 の分離テストを省略しない。PR 添付のスクリーンショットはダミーテナント(`client-a`/`demo-org`)で撮る。
- chronos のテナント切替は UX 上の混乱源になり得る。適用範囲を「テナント文脈が明示されている画面」に限定し、常にバナーで現在の文脈を表示する。
