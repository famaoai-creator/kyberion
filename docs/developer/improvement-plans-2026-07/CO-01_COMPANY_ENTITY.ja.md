# CO-01: 会社の集約エンティティと理念の runtime 配線

> 優先度: P1 / 規模: M / 依存: なし / 関連: [COMPANY_OS_CONCEPT](../COMPANY_OS_CONCEPT.ja.md)、`organization-profile`(既存)、`enterprise-operating-kernel.md`(概念)
>
> **なぜ重要か**: 「会社」が5つのファイル(customer.json / identity.json / organization-profile.json / vision.md / confidential 配下)に散在し、束ねるエンティティが無い。しかもテナント別の理念(vision)が authoring 止まりで実行に効かない。Company OS の土台となる「会社を1つの実体として扱う」層。

## 背景と課題

- **会社を束ねる集約オブジェクトが無い**: 会社情報が `customer/{slug}/customer.json`(財務・子会社)+ `identity.json`(創業者)+ `organization-profile.json`(経営既定)+ `vision.md`(理念)+ `knowledge/confidential/{slug}/`(組織図・財務詳細)に分散。`organization-profile-model.md` 自身が「full org chart ではない、governed default 層」と明言し、統合エンティティは意図的に不在。
- **テナント別 vision が未配線**: `vision/_default.md`(全社憲章)だけが runtime で読まれる(`core.ts:398` の `getGoldenRule`)。`customer/{slug}/vision.md` と `identity.json` は authoring 済みだが、テナントの理念・意思決定規範を runtime の perspective/persona 選択に解決する loader が無い。mission の `visionRef` は自由文字列で、パースされた憲章でない。

## ゴール(受入条件)

1. **`Company` 集約エンティティ**が定義され(スキーマ + loader)、1 テナントの vision・identity・organization-profile・組織参照・財務参照・KPI 参照(CO-03)を 1 つのビューに束ねる。散在する5ファイルは正本のまま、Company がそれらを集約する(二重管理しない)。
2. **テナント別 vision の runtime 配線**: `customer/{slug}/vision.md` の Soul/Steering/Destination が runtime で解決され、当該テナント文脈の mission・エージェントの判断(perspective/persona 選択、意思決定規範)に効く。`getGoldenRule` がテナント文脈を尊重する。
3. `mission` の `visionRef` が、自由文字列でなく Company の vision への構造化参照になる(IL-01 の goal 貫通と整合)。
4. `sovereign_dashboard` / management-control-plane が Company エンティティを表示の起点にする(UX-06/SU の customer overlay 対応と統合)。

## 実装タスク

### Task 1: Company スキーマと loader — `claude-sonnet-4`

1. `schemas/company.schema.json` を定義: `{ company_id, name, sovereign, vision_ref, organization_profile_ref, org_chart_ref (CO-02), financial_ref (CO-03), decision_rights_ref (CO-04), tenant_slug }`。既存5ファイルへの参照で構成し、内容を複製しない。
2. `libs/core/company.ts`: `resolveCompany(tenantSlug)` が5ファイルを集約した読み取りビューを返す。secure-io + tier-guard 経由(confidential 参照は tier を尊重)。
3. unit test: 集約ビューの構築、欠落ファイルの graceful 処理。

### Task 2: テナント別 vision の配線 — `claude-sonnet-4`

1. `libs/core/vision-resolver.ts`: `resolveVision(tenantSlug)` が `customer/{slug}/vision.md`(なければ `vision/_default.md`)をパースし、Soul/Steering/Destination の構造化オブジェクトを返す。
2. `getGoldenRule`(`core.ts:398`)をテナント文脈対応にする(現状のハードコードフォールバックは維持)。テナントの意思決定規範が perspective/persona 選択(persona-loader)に効く経路を1つ通す。
3. UX-06/ONB-03 の customer-overlay resolver と共有(personal ハードコード問題と同根)。
4. テスト: テナント別 vision 解決、フォールバック、規範の反映。

### Task 3: mission の visionRef 構造化 — `claude-sonnet-4`

1. mission 作成(IL-01 の goal 貫通経路)で、`visionRef` を Company の vision への構造化参照にする。outcome contract(`outcome-contract.ts:91-97`)の「aligned to ${visionRef}」を、パースされた Victory Conditions と突き合わせられる形に。
2. IL-04 の完了突合が、成果を「元の goal」だけでなく「会社の Victory Conditions」とも照合できるようにする(会社の目的への整合)。
3. テスト: mission goal と会社理念の整合チェック。

### Task 4: ダッシュボードの Company 起点化 — `claude-haiku`

- `sovereign_dashboard` と Chronos の management-control-plane 表示起点化が完了し、Company エンティティ(会社名・創業者・理念要約・組織/財務/決裁へのリンク)を先頭に表示する。UX-06 Task 2/3 の customer overlay 対応と統合。

## リスクと注意

- Company は既存5ファイルの集約ビューであり**新たな正本を作らない**(二重管理禁止)。各ファイルが正本のまま。
- テナント vision の runtime 配線は判断に影響する。まず「参照可能にする(エージェントが読める)」まで実装し、「規範を強制する(判断を変える)」は慎重に段階導入(誤った規範適用を避ける)。
- confidential テナントの財務・組織参照は tier 隔離を厳守(Company ビューが tier をまたいで漏らさない)。

## 実装メモ

- 2026-07-05: `libs/core/company.ts` と `libs/core/vision-resolver.ts` を追加し、`customer/{slug}/customer.json` / `identity.json` / `organization-profile.json` / `vision.md` と confidential 配下の参照を 1 つの読取ビューに束ねる基盤を実装した。
- 2026-07-05: `knowledge/product/schemas/company.schema.json` を追加し、`getGoldenRule` は tenant-aware な vision 解決を優先するようにした。
- 2026-07-05: mission 作成の `visionRef` を company 参照 URI(`company://<tenant>/vision`) に寄せ、Company vision を起点にした構造化参照へ切り替えた。
- 2026-07-05: `sovereign_dashboard` に Company overview を追加し、Company 起点の表示を実装した。
- 2026-07-05: Chronos の management-control-plane に Company context を追加し、Mission Control を Company 起点で表示するようにした。
- 2026-07-05: `scripts/refactor/mission-creation.ts` の `normalizeMissionVisionRef` を公開し、`company://` / `vision://` / legacy free string の正規化を contract test で固定した。
- 2026-07-05: `scripts/refactor/mission-controller-router.ts` で mission の routing decision に `vision_ref_summary` を載せ、Company vision 参照が mission state の経路記録にも残るようにした。
- 2026-07-05: `libs/core/outcome-contract.ts` に `vision_ref` を追加し、mission outcome contract でも `company://<tenant>/vision` の構造化参照を保持できるようにした。
- 2026-07-05: `libs/core/mission-context-pack.ts` / `.test.ts` でも mission outcome contract の `vision_ref` をそのまま pack に保持することを固定し、context pack 層で構造化参照が落ちないようにした。

## 実装メモ 追記 (2026-07-06)

- 業態別会社テンプレート(`templates/companies/`、CO-02 追記参照)が Company 集約の構成ファイル(customer.json / identity.json / vision.md / organization-profile.json / org-chart.json)を一式で生成するようになった。`pnpm company:bootstrap` 後に `resolveCompany(tenantSlug)` がそのまま集約可能。

## 実装メモ 追記 (2026-07-14): `getGoldenRule` テナント対応精査(STATUS.ja.md 残作業)

- コード精査: `fileUtils.getGoldenRule()`(`libs/core/core.ts:440`)は `resolveVision()` を**引数なしで**呼ぶ。`resolveVision(tenantSlug?, rootDir?)`(`libs/core/vision-resolver.ts:200-201`)側が `tenantSlug?.trim() || customerResolver.activeCustomer() || null` という内部フォールバックを持ち、`KYBERION_CUSTOMER` 環境変数からテナントを解決する実装は 2026-07-05 の時点で**既に実装済みだった**。
- ただし当時はこのフォールバック経路(`getGoldenRule` → `resolveVision()` 引数なし → `activeCustomer()`)を通しで検証するテストが一切無かった(`vision-resolver.test.ts` は `resolveVision('acme', tmpRoot)` と明示 tenantSlug を渡すケースのみ、`getGoldenRule` 自体には直接のテストが皆無)。「実装済みだが未検証」という状態で、STATUS.ja.md の「残: getGoldenRule のテナント対応精査」は正しい指摘だった(AC-06 のような完全な陳腐化ではなく、検証の欠落)。
- 対応: 2点のテストを追加。(1) `vision-resolver.test.ts` に `KYBERION_CUSTOMER` 環境変数を実際に設定/削除して `resolveVision(undefined, tmpRoot)` を呼ぶテスト(tenant 解決とグローバルフォールバック両方を実ファイルで固定)。(2) `core.test.ts` に `resolveVision` をモックして `fileUtils.getGoldenRule()` が引数なしでそれを呼ぶこと(= テナント解決の責務を `resolveVision` 側に委譲していること)を固定するテスト。
- 検証: `npx tsc --noEmit` 緑、`vision-resolver.test.ts` + `core.test.ts` 計22本緑、`libs/core` 全体 2754/2755 緑(残る1件は node_modules シンボリックリンクループという環境要因で無関係)。
