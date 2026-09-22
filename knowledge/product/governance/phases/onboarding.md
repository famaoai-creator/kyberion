---
title: 'Phase Protocol: Onboarding'
tags: [governance, lifecycle, onboarding]
last_updated: 2026-09-22
runtime_stages: [intake, classification]
---

# Phase Protocol: ① Onboarding (Ecosystem Initialization)

## 目的

環境、identity、（必要なら）tenant と organization、実行権限を順に準備し、最初の仕事を安全に
開始できる状態へ進める。

手順の順序の正本は [オンボーディング標準フロー](../onboarding-flow.md) である。この文書は
lifecycle phase から参照する短い runbook で、各項目の番号は標準フローの Step に対応する。

## ルートを決める

| ルート              | 通る Step                                               |
| ------------------- | ------------------------------------------------------- |
| 1. 個人のみ         | 0 → 1 → 2 → 3 → 4 → 9                                   |
| 2. AI 会社          | 0〜4 → 5〜8（`onboard company` で 5・6 をまとめる） → 9 |
| 3. 既存テナント追加 | 0〜9 すべて                                             |

## 実行順

### Step 0〜2: baseline・導入・readiness

```bash
pnpm pipeline --input pipelines/baseline-check.json
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain   # dist/ を使うので build の後
pnpm doctor
pnpm kyberion setup report --persona first-time-user
pnpm kyberion secret introduce <service-id> <secret-key>   # 必要な secret だけ。値は argv に載せない
pnpm surfaces reconcile
```

baseline が `needs_recovery` または `fatal_error` の場合は、通常の onboarding を始めず、
それぞれ recovery または障害修復へ分岐する。

### Step 3: stance を決めてから identity を保存する

顧客・会社として使う場合は、先に `pnpm customer:switch <customer-slug>` を実行する。
baseline の L3 はアクティブな profile の identity を見るため、順序を逆にしない。

```bash
pnpm onboard
# または（非対話）
pnpm onboard apply --identity <reviewed-identity-json> --dry-run
pnpm onboard apply --identity <reviewed-identity-json>
```

GUI では concierge（`http://127.0.0.1:3050`）の `/settings` から保存できる。メンバーと承認者も
ここで登録する。この段階では外部効果や mission を開始しない。

### Step 4: baseline を all_clear にする

baseline を再実行し、`needs_attention` が残れば失敗層を確認する。初回は L8（storage janitor）、
L10（chronos scheduler）、L11（監査台帳）が落ちやすい。対処は標準フロー Step 4 を参照する。

ルート 1 はここで Step 9 へ進む。

### Step 5〜8: tenant・binding・activation・first-work

```bash
pnpm tenant create <tenant-slug> --display-name "<Tenant name>" --assigned-role owner --apply
pnpm check -- --only tenant-registry
pnpm onboarding:context bind --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id> --dry-run --json
pnpm onboarding:context bind ... --apply --json
pnpm tenant:activation plan --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id>
pnpm tenant:activation activate ... --owner-id human:<owner> --nhi-id <nhi-id> \
  --check-viewer-scope --check-nhi --check-services --check-isolation \
  --probe-ref viewer_scope=<audit-ref> --probe-ref nhi_provisioned=<audit-ref> \
  --probe-ref service_readiness=<audit-ref> --probe-ref isolation_probe=<audit-ref> \
  --apply --accept
pnpm onboarding:context first-work --customer-slug <customer-slug> \
  --intent "<最初の依頼>" --dry-run --json
```

未登録、`suspended`、`archived`、または reserved scope 名の tenant は先へ進めない。
activation receipt が `active` になるまで、first-work の apply と tenant に紐づく mission は
fail-closed で停止する。オプションの詳細は標準フロー Step 5〜8 を参照する。

### Step 9: 完了確認

```bash
pnpm pipeline vital-check
pnpm pipeline --input pipelines/baseline-check.json
```

## 再開と失敗時の扱い

```bash
pnpm onboarding:context show --customer-slug <customer-slug> --json
pnpm tenant:activation reconcile --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> --organization-id <organization-id>
pnpm tenant:activation resume ... --apply --accept
```

probe をやり直さずに activation を再開しない。停止・ロールバック・offboarding は
`tenant:activation suspend|rollback` の governed command を使い、state を直接編集しない。
identity のやり直しは `pnpm onboard reset` を使う。

## 成功条件

1. identity と onboarding summary がアクティブな profile に保存されている。
2. `pnpm pipeline vital-check` が成功し、baseline-check が `all_clear` である。
3. （ルート 2・3）tenant registry と consistency check が成功している。
4. （ルート 2・3）customer、tenant、organization の binding が一致している。
5. （ルート 2・3）activation receipt が `active` で、必須 probe と責任を持つ人間が記録されている。
6. （ルート 2・3）first-work がレビュー済みで、typed context と approval boundary が定まっている。

## 関連文書

- [オンボーディング標準フロー](../onboarding-flow.md)
- [docs/INITIALIZATION.md](../../../../docs/INITIALIZATION.md)
- [テナント追加手順](../tenant-onboarding-procedure.md)
