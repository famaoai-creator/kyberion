---
title: オンボーディング標準フロー — Tenant / Organization / Activation
tags: [governance, onboarding, tenant, organization, activation, first-work]
last_updated: 2026-08-15
kind: governance
scope: repository
authority: standard
phase: [onboarding, alignment, execution]
---

# オンボーディング標準フロー

この文書は、Kyberion を初期化してから、tenant の機密境界と organization の運用モデルを
確定し、最初の仕事を安全に開始するまでの正本である。環境のインストール詳細は
[`docs/INITIALIZATION.md`](../../../docs/INITIALIZATION.md)、日々のフェーズ運用は
[`phases/onboarding.md`](./phases/onboarding.md)を参照する。

## 1. 全体像

オンボーディングは「identity を保存したら完了」ではない。次の順序で状態を進める。

```text
baseline
  → environment / identity
  → tenant registry
  → customer stance + organization context binding
  → tenant activation (probes + human acceptance)
  → first-work review / routing
  → mission or organization work
  → review / feedback
```

最初の仕事を実行できる条件は、`organization-context.json` が存在することではなく、
対応する tenant / organization / tier の activation receipt が `active` であることである。

## 2. 3 つの名前を混同しない

| 名前              | 意味                                                | 正本・用途                                                                                       |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `customer_slug`   | いまどの主体として振る舞うかという stance           | `customer/{slug}/` と `KYBERION_CUSTOMER`。認可境界ではない                                      |
| `tenant_slug`     | 機密性、認可、監査の境界                            | `knowledge/personal/tenants/{slug}.json` の registry profile と `knowledge/confidential/{slug}/` |
| `organization_id` | tenant をどう運営するかという目的・責任・運用モデル | governed organization facade が管理する状態                                                      |

包含順は常に次の一つである。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

`customer/{slug}` はこの chain の一階層ではなく stance overlay である。customer 側にある
tenant JSON は表示・契約上の facet になり得るが、tenant registry の代替にはならない。

## 3. 標準手順

### Step 0: baseline を確認する

セッション開始時は次を実行し、結果に従う。

```bash
pnpm pipeline --input pipelines/baseline-check.json
```

- `needs_onboarding`: Step 1 へ進む
- `needs_recovery`: suspension point を復元してから再開する
- `needs_attention`: 失敗層を操作者へ示し、alignment へ戻る
- `all_clear`: alignment で今回の目的を確認する
- `fatal_error`: pipeline 自体を修復するまで実行しない

### Step 1: 環境と identity を初期化する

```bash
pnpm install
pnpm prereq:check
pnpm build
pnpm setup:report --persona first-time-user
pnpm surfaces:reconcile
pnpm onboard
```

TTY がない場合は、identity の dry-run を確認してから適用する。

```bash
pnpm onboard:apply \
  --identity knowledge/public/templates/onboarding/identity.example.json \
  --dry-run
pnpm onboard:apply \
  --identity <reviewed-identity-json>
```

この段階で作られるのは個人 identity、vision、agent identity、onboarding summary、
connection 候補、tenant 候補、tutorial plan である。外部サービスへの書き込みや、
最初の mission の実行はまだ行わない。

### Step 2: tenant registry を登録・検証する

オンボーディング入力に含まれる tenant は候補または stance 側の facet として扱い、
機密境界の正本登録は governed facade で行う。

```bash
pnpm tenant create <tenant-slug> \
  --display-name "<Tenant name>" \
  --assigned-role owner \
  --apply
pnpm tenant show <tenant-slug> --json
pnpm run check:tenant-registry
```

registry が `active` でない tenant、未登録 tenant、tier 名と衝突する tenant は後続の
binding と activation に進めない。customer stance を切り替えても、registry の正本は
変わらない。`pnpm company:onboard --tenant-slug <tenant>` はこの登録と context binding を
まとめて行う governed facade だが、適用後の consistency check と activation は省略しない。

### Step 3: customer stance と organization を結合する

まず stance を選び、次に tenant と organization の結合を dry-run で確認する。

```bash
export KYBERION_CUSTOMER=<customer-slug>

pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --dry-run --json
```

内容を確認してから apply する。

```bash
pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --apply --json
```

この apply は `customer/{customer-slug}/onboarding/organization-context.json` と、
tenant-bound な organization state を作成または再利用する。これは activation ではない。

### Step 4: tenant activation を検証し、人間が受け入れる

activation は context binding の存在だけで完了しない。registry、organization state、
accountable human、memory policy に加え、viewer scope、NHI、service readiness、
isolation probe を明示的に確認する。

```bash
pnpm tenant:activation plan \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id>

pnpm tenant:activation activate \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --owner-id human:<owner> \
  --nhi-id <nhi-id> \
  --check-viewer-scope \
  --check-nhi \
  --check-services \
  --check-isolation \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref nhi_provisioned=<audit-ref> \
  --probe-ref service_readiness=<audit-ref> \
  --probe-ref isolation_probe=<audit-ref> \
  --apply --accept
```

`--accept` は人間の受け入れを表す。成功すると
`customer/<customer-slug>/onboarding/tenant-activation/<tenant>/<organization>/<tier>/activation.json`
に full-context activation receipt が保存され、status が `active` になる。receipt には stance、tenant、organization、tier、
owner、NHI、次の行動、および task lease / heartbeat watchdog / quota・budget /
approval gate / pause・escalation / drift watcher の operation contract と、各 probe の監査証跡 ref が記録される。

### Step 4.1: 設定変更と外部入口の追加

オンボーディング後の service binding、surface、channel、MCP grant、quota、egress の変更も、
直接 JSON を編集せず `config-mission` の scoped change として扱う。

```bash
pnpm config-mission create --preset <preset> --tenant <tenant> \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref service_readiness=<audit-ref>
pnpm config-mission request-approval --tenant <tenant> --id <cfg-id>
pnpm config-mission apply --tenant <tenant> --id <cfg-id>
```

`brief.json` の `change` は target scope、risk、desired fingerprint、probe refs、approval ref を
保持する。system scope の surface exposure や external egress、credential、cross-tenant binding は
human approval と payload hash 一致がなければ apply できない。apply 後は reconcile と receipt を
確認し、失敗時は同じ change を無変更で再実行せず、recovery / rollback point を確認してから再開する。

### Step 5: first-work を洗い出し、レビュー後に実行する

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --dry-run --json
```

分類結果を確認する。

- `solution_project`: Project bootstrap を提案する
- `service_operation` / `routine_operation` / `incident_response` /
  `governance_cadence` / `improvement_experiment`: organization operating model の対応する
  管理単位へ接続する
- 未確定、低 confidence、approval required: 実行せず human decision を求める

activation が `active` でない場合、first-work の apply は fail-closed で拒否される。
レビューと受け入れ後にだけ apply する。

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --apply --accept
```

`solution_project` の場合は Project bootstrap の情報も明示する。

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --apply --accept \
  --bootstrap-project \
  --project-id <project-id> \
  --project-name "<project-name>" \
  --project-summary "<project-summary>"
```

mission に昇格する仕事は、作成と開始を分けて governed mission controller を使う。
開始前に scope、budget、success condition、外部副作用の approval boundary を再確認する。

```bash
pnpm mission create <mission-id> \
  --tier confidential \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --goal "<最初の依頼>" \
  --success-condition "<受け入れ条件>"
pnpm mission start <mission-id>
```

契約、支払い、外部公開、credential・authority 変更などは、first-work review 後も人間の
承認なしに確定しない。

## 4. 再開・停止・ロールバック

途中状態は削除してやり直さず、状態を確認してから再開する。

```bash
pnpm onboarding:context show --customer-slug <customer-slug> --json
pnpm tenant:activation reconcile \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id>
pnpm tenant:activation resume ... --apply --accept
pnpm tenant:activation suspend ... --reason "<reason>" --apply --accept
pnpm tenant:activation rollback ... --reason "<reason>" --apply --accept
```

activation を suspend すると、tenant の task-scoped grant は revoke される。再開時は
probe をやり直し、同じ activation receipt を更新する。offboarding と archived tenant は
tenant-bound read/write、memory retrieval、NHI、grant、projection を fail-closed にする。

## 5. 完了条件

- identity と onboarding summary が保存されている
- tenant registry の正本が一意で `active`、`check:tenant-registry` が成功している
- customer stance、tenant、organization の binding が一致している
- activation receipt が `active` で、全必須 probe と human acceptance が記録されている
- scope chain が `tenant_slug → organization_id → project_id → mission_id → task_id` の typed context で保持されている
- first-work が dry-run でレビュー済みで、実行形と approval boundary が確定している
- 初回外部効果は human approval の内側にある

## 関連文書

- [Phase Protocol: Onboarding](./phases/onboarding.md)
- [テナント追加手順](./tenant-onboarding-procedure.md)
- [entity-scope-hierarchy](../architecture/entity-scope-hierarchy.md)
- [stance-tenant-customer-model](../architecture/stance-tenant-customer-model.md)
- [Tenant / Organization / Onboarding / Autonomous Operations 統合計画](../../../docs/developer/improvement-plans-archive/2026-08/TENANT_ORGANIZATION_ONBOARDING_AUTONOMY_PLAN_2026-08-15.ja.md)
