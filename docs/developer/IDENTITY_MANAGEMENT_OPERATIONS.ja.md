---
title: Identity Management Operations (human + NHI)
tags: [organization, member, nhi, operations]
last_updated: 2026-10-08
---

# 人とNHIの管理

Actor語彙: `human=user:<member_id>` / `agent|service=kyberion://agent/<org>/<slug>`。空一覧(`[]`)は該当なし、`show`の不一致は `identity not found`。`orphan=true` は責任者・scopeの再指定が必要。

## 読取(新規・非破壊)

```bash
pnpm organization identity list [--organization-id <id>] [--tenant-slug <slug>] [--kind human|agent|service] [--include-retired] [--json]
pnpm organization identity show --actor <user:id|nhi_id> [--json]
```

実装: `libs/core/organization/identity-directory.ts` が `member-registry` + `agent-identity` + `listOrphanNhiIdentities` を束ねる。Surface `設定›組織とメンバー` は同reader参照。

## 書込(既存verb委譲・直編集なし)

| 目的             | コマンド                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| human紐付け/解除 | `pnpm organization member link-identity/unlink-identity <member-id> --slack/--issuer --subject` |
| 招待             | Surface 招待リンク(`/join`)、単回・72h・owner招待不可                                           |
| NHI発行          | `pnpm onboarding company`(初回ceo-operator)、以後mission staff時にbest-effort provision         |
| 検証             | `pnpm tenant:activation probe --nhi-id <id>` の `nhi_provisioned`                               |
| チーム           | `mission_controller team/staff/restaff`                                                         |
| 常駐             | `pnpm kyberion agent-runtime manage`、`dot list/activate/pause/retire/wake/status`              |
| 承認所有         | `mission_controller memory-approve --owner-nhi <NHI> --decided-by user:<member>`                |

`KYBERION_NHI_ACTOR` 既定warn維持。enforce切替は観測後の単独判断。
