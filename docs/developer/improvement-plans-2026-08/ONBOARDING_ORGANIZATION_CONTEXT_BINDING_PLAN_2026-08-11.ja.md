---
title: オンボーディング後の Organization / Project Context Binding 改善計画
tags: [improvement-plan, onboarding, organization, project, tenant, work-shape]
last_updated: 2026-08-12
status: completed
---

# オンボーディング後の Organization / Project Context Binding 改善計画

## 目的

オンボーディング完了後に、利用者が ID を手作業でコピーせず、現在の顧客・テナント・組織を確認したうえで最初の仕事を適切な管理単位へ接続できるようにする。

既存の containment scope は次の順序を正本とする。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

ただし、Project は新しい成果物や能力を作る `solution_project` の管理単位であり、定常運用・サービス運用・インシデント・ガバナンス・実験を必ず Project 化しない。Work Shape に応じて Project 以外の typed relation を選択する。

## 用語と責務

| 要素                       | 責務                                                  |
| -------------------------- | ----------------------------------------------------- |
| `customer_slug`            | 顧客・契約・運用オーバーレイの選択                    |
| `tenant_slug`              | データ分離、認可、監査の境界                          |
| `organization_id`          | 組織の目的、責任者、運用モデル                        |
| `project_id`               | 期限付きの Solution / Change 管理単位。必要時のみ存在 |
| `mission_id`               | durable な実行所有単位                                |
| `task_id` / `task_session` | 個別作業と再開可能な実行コンテキスト                  |

`customer_slug` と `tenant_slug` は同一値であることを要求しない。1 customer に複数 tenant、1 tenant に複数 organization を許可し、オンボーディング時は active context を一つ選択する。

## 標準フロー

1. customer overlay を選択・確認する。
2. tenant profile を選択し、active tenant であることを検証する。
3. organization profile を解決し、organization operational state と purpose を governed facade 経由で作成または再利用する。
4. `onboarding-context-binding.json` に customer / tenant / organization の対応を記録する。
5. 最初の依頼を `organization work resolve` で dry-run 分類する。
6. `solution_project` の場合だけ `project bootstrap` を実行する。それ以外は service / operation / incident / cadence / experiment の管理単位へ接続する。
7. 作成した work item / mission に typed `context` と lineage を持たせる。

## 実装範囲

### P0: Context Binding 契約

- `knowledge/product/schemas/onboarding-context-binding.schema.json` を追加する。
- `customer/{customer_slug}/onboarding/organization-context.json` を governed record とする。
- dry-run では書き込みを行わず、適用時だけ既存の secure-io と organization facade を使う。
- tenant registry、tier、organization の不一致は fail-closed にする。

### P1: Onboarding Context Facade

- `libs/core/onboarding-context.ts` を追加する。
- `resolveOnboardingContext`、`applyOnboardingContextBinding`、`loadOnboardingContextBinding` を提供する。
- 既存 binding と一致する場合は再利用し、重複 organization / project を作らない。
- organization state が存在しなければ `buildOrganizationScaffold` と保存 facade で初期化する。

### P2: First Work Routing

- `resolveOnboardingFirstWork` で binding の tenant / tier / organization context を `resolveOrganizationWork` へ渡す。
- `solution_project` の場合だけ明示的な apply と project bootstrap を許可する。
- 未確定・低 confidence・approval required の結果は実行せず、安定した状態コードと次の質問を返す。
- 表示文言は新規に日本語を判定ロジックへ埋め込まず、既存 catalog または stable code を使用する。

### P3: CLI / 再開 / 検証

```text
pnpm onboarding:context show --customer-slug <slug> --json
pnpm onboarding:context bind --customer-slug <slug> --tenant-slug <slug> --apply --json
pnpm onboarding:context first-work --customer-slug <slug> --intent "..." --dry-run --json
pnpm onboarding:context first-work --customer-slug <slug> --intent "..." --apply --bootstrap-project ...
```

- `show`、`bind`、`first-work` はすべて dry-run を既定にする。
- apply は binding、管理単位レコード、または project bootstrap の対象を JSON で明示する。
- `solution_project` と `routine_operation`、tenant mismatch、rerun を契約テストで検証する。

## 受け入れ条件

1. 初回オンボーディングから context binding まで ID の手入力なしに到達できる。
2. customer / tenant / organization の不整合は書き込み前に拒否される。
3. Project が不要な仕事に Project を自動作成しない。
4. WorkItemContext は labels / metadata ではなく typed context を使用する。
5. dry-run と apply の書き込み範囲が分離される。
6. 再実行しても同じ binding / organization / project が再利用される。
7. cross-tenant 参照が deny-unless-brokered となり監査可能である。
8. i18n 検査を通過し、日本語の表示文字列を新規の判定ロジックへ埋め込まない。

## 検証シナリオ

- company onboarding 後に tenant profile を登録して context bind できる。
- Project 型の first work が `solution_project` として提案される。
- 定常レポートが `routine_operation` として提案され、Project を作らない。
- customer と tenant の取り違え、異なる tenant の organization、inactive tenant が拒否される。
- 同じ bind / bootstrap を再実行しても重複しない。
- `pnpm typecheck`、対象 Vitest、`pnpm check:i18n`、`git diff --check` を通過する。

## 実装結果

- P0〜P3 の facade、schema、CLI、first-work routing、company onboarding の next command、契約テストを実装済み。
- Project の作成は `solution_project` に限定し、他の Work Shape は分類結果のみを返す。
- `rootDir` を受け取る governed facade は customer overlay と同一 root に保存し、別 worktree の状態混入を防止する。
- Project bootstrap と binding apply は途中失敗時に作成済みの一時レコードを補償削除し、既存 binding を rollback 復元する。bootstrap 完了監査は commit hook 成功後だけ記録する。
- bootstrap 後の監査失敗にも commit rollback hook を適用し、監査抑止は公開 Project facade から利用できない内部経路に限定する。
- 非 Project の first work は operation / incident / cadence を既存 facade で作成し、既存 service / operation / incident / cadence の参照は organization・tenant・tier と実在性を検証する。experiment は governed record が存在しない状態での外部 ID 参照を拒否する。
- `onboarding-first-work` record と WorkItem に human decision、work shape、management unit、tenant、organization の typed lineage を保存する。default service は実 service ID を記録し、Project context の不一致を拒否する。Mission への昇格は mission controller の governed promotion に委譲する。
- 既存 binding は organization state が欠落した場合に stale と判定し、dry-run で正しい `organization-state.json` を提示して apply 時に修復する。Project / task session / mission seed / WorkItem の rootDir も同じ保存境界へ伝播する。
- company onboarding は tenant binding 失敗時に、テンプレート materialization・profile・readiness・first-work plan を元の状態へ復元する。organization profile schema と生成 workforce の契約も一致させる。
- 既存の `organization` / `project` / `mission` facade の責務と tenant 境界は変更しない。
