# CO-02: 組織図のデータ化とカスタムロール作成フロー

> 優先度: P2 / 規模: M / 依存: CO-01(会社エンティティ)、AA-03(trust)、SA-05(権限) / 関連: 既存 authority model / role-authority-map / agent-profile-index
>
> **なぜ重要か**: 「CFO エージェントを雇う」「営業部を作る」が、今は SYSTEM tier の config 手編集でしか実現できない。組織図がデータでなく、カスタムロール作成のユーザーフローが無い。会社の組織を宣言的に定義・変更できるようにする。

## 背景と課題

- **組織図がデータでない**: 唯一の実組織図データ `knowledge/confidential/sbinbs/organization/org-chart-2604.json` は非構造化のテナント知識で、スキーマも loader も無い。`org-chart.schema.json` も報告ライン/階層モデルも headcount/position primitive も無い。`organization-profile-model.md` は「full org chart ではない、mission ごとに derive」と明言し、固定組織図を意図的に避けている。
- **カスタムロール作成が config 手編集**: 権限を持つ新役割(CFO 等)を作るには `authority-roles/*.json` + `role-authority-map.json` + `security-policy.json` を SYSTEM tier で手編集。ユーザー向けの「役割を作る」フローが無い。既存のビジネス role(finance_controller, strategic_sales)は context-only(runtime 権限なし)で、advise はできるが act できない。

## ゴール(受入条件)

1. **組織図がデータ化**される(`org-chart.schema.json`): 役割・報告ライン・担当者(agent/人間)・責務範囲を構造化。ただし Kyberion 思想(mission ごとに derive)を尊重し、**固定組織図でなく「既定編成 + mission 派生」の二層**にする(組織図は既定・出発点、実行時はそこから mission チームを derive)。
2. **カスタムロール作成フロー**: `pnpm org role create`(または surface UI)で、新役割を「知識(責務)+ authority(権限)+ persona + capabilities」の一式として宣言的に作れる。SYSTEM tier の複数ファイル手編集を1フローに集約。
3. ビジネス role(finance_controller 等)が、advise だけでなく限定的に act できる authority を持てる(context-only の解消。ただし SA-05 の承認ゲート下で)。
4. 組織図が CO-01 の Company エンティティに紐付く。

## 実装タスク

### Task 1: 組織図スキーマとデータ化 — `claude-sonnet-4`

1. `schemas/org-chart.schema.json`: `{ positions: [{ role_id, reports_to, held_by (agent_id|human), responsibility_scope, authority_role_ref }], domains }`。既存 `personalities/roles.json` の5ドメイン + `sbinbs/org-chart-2604.json` の実例を参考に。
2. `libs/core/org-chart.ts`: 組織図を読み、mission チーム編成(mission-team-composer)の**既定出発点**として提供する。実行時は既存どおり mission ごとに derive(組織図は上書き可能な既定、固定でない)。
3. テスト: 組織図の読み込み、mission チーム derive の出発点として機能。

### Task 2: カスタムロール作成フロー — `claude-sonnet-4`

1. `pnpm org role create --name CFO --domain leadership --authority ...` を実装: `authority-roles/*.json` + `role-authority-map.json` + `security-policy.json` + `roles/{id}/PROCEDURE.md` を一括生成/更新する(SYSTEM tier 書き込みは承認ゲート SA-05 下)。
2. スキーマ検証 + `check:catalogs`(整合)を通す。ロール作成自体が高権限操作なので承認必須。
3. テスト: 新ロール作成 → 権限・責務・persona が一貫して登録されること。

### Task 3: ビジネスロールの act 化 — `claude-sonnet-4`

1. context-only ビジネス role(finance_controller, strategic_sales, marketing_growth 等)に、限定的な authority_role を割り当てられるようにする(例: finance_controller が請求データを読み書きできる限定 write scope)。SA-05 の承認ゲート + 判断基準ルーブリック下で。
2. 「advise → act」の昇格は明示的操作(自動でなく、創業者が権限を付与)。
3. テスト: ビジネス role が限定権限で実行でき、範囲外は拒否されること。

### Task 4: Company への紐付け — `claude-haiku`

- 組織図を CO-01 の Company エンティティに `org_chart_ref` で紐付け、SU-01 のホーム/ダッシュボードで組織図を表示できるようにする。

## リスクと注意

- **Kyberion の「固定組織図を作らない」思想と衝突しないこと**が最重要。組織図は「既定の出発点」であって「実行を縛る固定構造」ではない。mission ごとの動的編成を殺さない(組織図 = デフォルト、mission derive = 実際)。
- カスタムロール作成 + ビジネスロールの act 化は権限拡大操作。SA-05 の承認・判断基準の4軸(不可逆×広域は人間)を厳守。誤って過大権限を付与しないよう、新ロールの権限は最小から始める。
- 組織図データに人名・報告ラインが入るとテナント機密になり得る。tier 隔離(CO-01 と同じ)。

## 実装メモ

- 2026-07-05: `libs/core/org-chart.ts` を追加し、`knowledge/product/personalities/roles.json` と `team-role-index.json` を既定出発点として派生組織図を生成できるようにした。
- 2026-07-05: `libs/core/mission-team-plan-composer.ts` に `organization_chart` の概要を載せ、mission plan が組織図の既定編成を参照できるようにした。
- 2026-07-05: `pnpm org role create` を追加し、`authority-roles/*.json` / `team-roles/*.json` / `role-authority-map.json` / `security-policy.json` / `roles/{id}/PROCEDURE.md` / `mission.md` を一括生成・更新できるようにした。
- 2026-07-05: `security-policy.json` と `role-authority-map.json` に finance_controller / strategic_sales / marketing_growth / talent_culture / line_manager の限定 authority_role を追加し、`validateWritePermission` が business role の act を認める最小経路を実装した。
- 2026-07-05: `pnpm org role promote` を追加し、既存 role の advise→act 昇格を明示操作として扱えるようにした。昇格時は authority role / team role / security policy / role-write-access / role-authority-map / promotion notes を一括更新する。

## 実装メモ 追記 (2026-07-06) — 業態別 会社・組織図テンプレート

- `templates/companies/` に業態別会社テンプレート 5 種を追加: `saas-product-company` / `consulting-firm` / `marketing-agency` / `financial-services-backoffice` / `it-managed-services`。各テンプレートは `organization-profile.json` + `org-chart.json`(ドメイン・ポジション・レポートライン・authority 参照)+ `customer.json` / `identity.json` / `vision.md` + README で構成。
- 組織図は全業態で「CEO のみ `held_by: human`(最終決裁は人間)、他はエージェント」を既定とし、CO-02 の「既定の出発点」原則を README に明記。role_id は `knowledge/product/roles/` の 26 ビジネスロール、authority_role_ref は `governance/authority-roles/` の実在 id のみ使用(契約テストで強制)。
- 業態別チームテンプレートカタログ 5 種を `organization-team-template-catalogs/` に追加し、各プロファイルの `team_defaults.team_template_catalog_id` から参照。
- 実体化 CLI `pnpm company:bootstrap --vertical <id> --slug <slug> --name "<会社名>"`(`scripts/company_bootstrap.ts`)を追加。プレースホルダ置換で `customer/<slug>/` に生成し、`resolveOrganizationOrgChart` / `loadOrganizationProfile` / `composeMissionTeamPlan`(organization_chart summary)まで E2E 確認済み。
- 契約テスト `tests/company-vertical-templates-contract.test.ts` がスキーマ適合・ロール/権限の実在・レポートライン解決・「root は human 1 名」を全業態に対して固定。

## 実装メモ 追記 (2026-07-14): カスタムロール作成フロー精査(STATUS.ja.md 残作業)

STATUS.ja.md の「残: カスタムロール作成フロー精査」を実コード・実テストで再突合。CO-01(getGoldenRule)と異なり、今回は**全4タスクとも実装・テストの両方が既に揃っていた**(真の陳腐化、追加実装は不要):

- Task 1(組織図データ化): `knowledge/product/schemas/org-chart.schema.json` 実在、`libs/core/org-chart.ts` が既定編成を提供。
- Task 2(カスタムロール作成フロー): `scripts/org.ts`(`pnpm org role create` / `pnpm org role promote`)+ `scripts/org.test.ts`(2テスト: 作成時の authority/team/policy/role doc 整合、既存 role の act 昇格)を確認・実行し緑。
- Task 3(ビジネスロールの act 化): `tests/governance-policy.test.ts` が `finance_controller` を財務ドメイン配下の書き込みは許可・無関係な procedure ファイルへの書き込みは拒否、と scope 限定を固定していることを確認(「advise だけでなく限定的に act」の受入条件と一致)。
- Task 4(Company への紐付け): `libs/core/company.ts` の `org_chart_ref` + `libs/core/company.test.ts` の該当アサーションで紐付けとテスト済みを確認。

検証: `scripts/org.test.ts` + `libs/core/company.test.ts` + `tests/company-vertical-templates-contract.test.ts` + `tests/governance-policy.test.ts` 計26テスト緑(既存テストの再実行、コード変更なし)。
