---
title: 'Mission finish と TaskCredentialBinding — CREDENTIAL_BINDING_REQUIRED の読み方と対処'
tags: [orchestration, mission, lifecycle, credentials, runbook]
last_updated: 2026-10-28
---

# mission finish と TaskCredentialBinding

## 症状

```
pnpm mission finish <MISSION_ID>
[mission:controller] [CREDENTIAL_BINDING_REQUIRED] Tenant credentials require a trusted binding
```

`--tenant-slug`、`--request-approval`、事前の `git fetch origin main` のいずれでも解消しない。

## 意味

`getSecret`(`libs/core/foundation/credential-binding.ts`)は、実行 identity が
`tenantSlug` を持つのに `TaskCredentialBinding` がプロセス内(AsyncLocalStorage)
に無いと拒否する — fail-closed 設計。`mission finish` 内部で
`describeProviderTierAvailability({ tenant_slug })` が provider の認証情報を解決し、
このチェックに到達する。

## なぜ直接 CLI では解決できないか

binding を作るのは `withConfiguredTaskCredentials(workItemId, run)`
(`libs/core/secret/task-credential-dispatch.ts`)だけで、これは **WorkItem claim を
dispatch ホストが保持している時だけ**呼ばれる。CLI 直打ちには claim が無いため
binding は決して生成されない — フラグでも env でも代替できない。これは
意図された境界である(スコープ外の credential を拾わせない)。

## 対処(優先順)

1. **委任(正規経路)** — finish 相当の作業を WorkItem として dispatch する
   (`pnpm mission dispatch-workitems` 系)。dispatch ホストが claim を取り、
   `bindTask({ scope, workItemId })` 経由で binding を生成して実行する。
   「委任に投げれば finish も binding 付きで走る」が設計意図。
2. **resolver 未設定の確認** — 委任しても tenant の `SecretResolver` に
   `bindTask` が無いと同じエラーになる。`pnpm kyberion tenant show <slug>` と
   `pnpm kyberion secret` 系で resolver の設定状態を確認し、必要なら secret を
   登録・適用してから再委任する。
3. **承認経路** — `pnpm kyberion approvals --approve <id>` が絡む
   approval-mediated フローは finish の binding を代替しない(人間承認は別レイヤ)。
   2 番の resolver 整備が先。

## 関連コード

- `libs/core/foundation/credential-binding.ts` — `getSecret` の拒否条件と `withTaskCredentialBinding`
- `libs/core/secret/task-credential-dispatch.ts` — `withConfiguredTaskCredentials`(claim 前提の binding 生成)
- `scripts/mission_controller.ts` — finish 時の `describeProviderTierAvailability` 呼び出し

## 教訓(遭遇した実例)

MSN-MOBILE-ACT-20261028 では verify → distill → memory-approve → memory-promote → PR マージ
まで完了した後、finish だけがこのエラーで残った。委任なら binding 付きで走れるが、
resolver 未設定環境では委任しても同じ結果になるため、2 番の環境整備が先決になる場合がある。
