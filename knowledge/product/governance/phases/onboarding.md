---
title: 'Phase Protocol: Onboarding'
tags: [governance, lifecycle, onboarding]
last_updated: 2026-08-15
runtime_stages: [intake, classification]
---

# Phase Protocol: ① Onboarding (Ecosystem Initialization)

## 目的

環境、identity、tenant、organization、実行権限を順に準備し、最初の仕事を安全に開始できる
状態へ進める。identity の保存だけではオンボーディング完了とはみなさない。

エンドツーエンドの正本は [オンボーディング標準フロー](../onboarding-flow.md) である。
この文書は lifecycle phase から参照する短い runbook とする。

## 実行順

### 1. Baseline と環境

```bash
pnpm pipeline --input pipelines/baseline-check.json
pnpm install
pnpm prereq:check
pnpm build
pnpm setup:report --persona first-time-user
pnpm surfaces:reconcile
```

baseline が `needs_recovery` または `fatal_error` の場合は、通常の onboarding を開始せず、
それぞれ recovery または障害修復へ分岐する。

### 2. Identity と個人 onboarding

対話環境では `pnpm onboard`、非対話環境では reviewed JSON を使う。

```bash
pnpm onboard
# または
pnpm onboard:apply --identity <reviewed-identity-json> --dry-run
pnpm onboard:apply --identity <reviewed-identity-json>
```

成果物は identity、vision、agent identity、onboarding state / summary、connection 候補、
tenant 候補、tutorial plan である。ここでは外部効果や mission を開始しない。

### 3. Tenant registry

tenant は `pnpm tenant create ... --apply` で登録する。正本は
`knowledge/personal/tenants/{tenant-slug}.json` であり、`customer/{slug}` の tenant facet や
`KYBERION_CUSTOMER` の切替に依存しない。登録後は次を実行する。

```bash
pnpm tenant show <tenant-slug> --json
pnpm check -- --only tenant-registry
```

未登録、`suspended`、`archived`、または reserved scope 名の tenant は次へ進めない。

### 4. Operating context binding

`customer_slug`（stance）と `tenant_slug → organization_id`（containment）を dry-run で
確認してから binding を適用する。

```bash
pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --dry-run --json
pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --apply --json
```

binding は organization state を作成または再利用するが、tenant activation そのものではない。

### 5. Tenant activation

activation plan で blockers を確認し、viewer scope、NHI、service readiness、isolation の
成功 probe と、それぞれに対応する監査証跡 ref を揃えてから、人間の `--accept` 付き apply を行う。

```bash
pnpm tenant:activation plan \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id>
pnpm tenant:activation activate \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --nhi-id <nhi-id> \
  --check-viewer-scope --check-nhi --check-services --check-isolation \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref nhi_provisioned=<audit-ref> \
  --probe-ref service_readiness=<audit-ref> \
  --probe-ref isolation_probe=<audit-ref> \
  --apply --accept
```

`customer/<customer-slug>/onboarding/tenant-activation/<tenant>/<organization>/<tier>/activation.json`
が `active` になるまで、first-work の apply と tenant-bound mission は fail-closed で停止する。

### 6. First work と review

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --dry-run --json
```

結果の work shape、管理単位、scope、budget、success condition、approval boundary を
人間が確認する。`solution_project` だけが Project bootstrap 候補になり、
`service_operation` / `routine_operation` / `incident_response` /
`governance_cadence` / `improvement_experiment` は organization operating model の管理単位へ接続する。

## 再開と失敗時の扱い

```bash
pnpm onboarding:context show --customer-slug <customer-slug> --json
pnpm tenant:activation reconcile --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> --organization-id <organization-id>
pnpm tenant:activation resume \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --nhi-id <nhi-id> \
  --check-viewer-scope --check-nhi --check-services --check-isolation \
  --probe-ref viewer_scope=<new-audit-ref> \
  --probe-ref nhi_provisioned=<new-audit-ref> \
  --probe-ref service_readiness=<new-audit-ref> \
  --probe-ref isolation_probe=<new-audit-ref> \
  --apply --accept
```

probe の再実行なしに activation を再開しない。停止・ロールバック・offboarding は
`tenant:activation suspend|rollback` の governed command を使い、直接 state を編集しない。

## 成功条件

1. identity / onboarding summary が保存されている。
2. tenant registry と consistency check が成功している。
3. customer、tenant、organization の binding が一致している。
4. activation receipt が `active` で、必須 probe と accountable human が記録されている。
5. first-work がレビュー済みで、typed context と approval boundary が定まっている。

## 関連文書

- [オンボーディング標準フロー](../onboarding-flow.md)
- [docs/INITIALIZATION.md](../../../../docs/INITIALIZATION.md)
- [テナント追加手順](../tenant-onboarding-procedure.md)
