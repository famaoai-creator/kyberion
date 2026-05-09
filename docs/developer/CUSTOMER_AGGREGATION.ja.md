---
title: 顧客集約ポイント
category: Developer
tags: [fde, customer, configuration, aggregation]
importance: 9
last_updated: 2026-05-07
---

# 顧客集約ポイント

FDE / 導入支援案件で、Kyberion を fork せずに顧客ごとの設定を分離するための仕組み。

詳細な英語版は [`CUSTOMER_AGGREGATION.md`](./CUSTOMER_AGGREGATION.md) を参照。日々の利用方法は [`customer/README.md`](../../customer/README.md)。

## 1. 課題

従来の Kyberion は 1 ユーザ前提:

- `knowledge/personal/` — 単一の主権者
- `knowledge/confidential/{project}/` — プロジェクト単位
- `knowledge/public/` — 再利用可能

FDE 案件では:

1. 同一 Kyberion インストールで複数顧客を扱う必要がある
2. 顧客 A と B の identity / connections / policy を完全分離する必要がある
3. fork なしで顧客導入を 80% 以上「設定」で吸収したい

## 2. 設計

リポジトリ直下に `customer/` ディレクトリを設置:

```
customer/
├── README.md                       (committed)
├── _template/                      (committed) — 新規顧客はここからコピー
└── {customer-slug}/                (gitignored) — 顧客ごと
    ├── customer.json
    ├── identity.json
    ├── vision.md
    ├── connections/
    ├── tenants/
    ├── policy/
    ├── voice/
    └── mission-seeds/
```

### 2.1 アクティブ化

```bash
export KYBERION_CUSTOMER=acme-corp
```

未設定時は既存の `knowledge/personal/` のみで動作（後方互換）。

### 2.2 解決順序

1. `customer/{slug}/{path}`（顧客オーバーレイ）
2. `knowledge/personal/{path}`（個人フォールバック）
3. `knowledge/public/{path}`（公開デフォルト、policy 等）

最初に見つかったパスを返す。書き込み時は customer 有効ならオーバーレイ側に書く。

### 2.3 slug 制約

```
^[a-z0-9][a-z0-9_-]*$
```

パストラバーサル（`..` / `/`）は拒否。検証は `libs/core/customer-resolver.ts` 経由必須。

### 2.4 秘密情報

`customer/{slug}/` は gitignored だが、それでも秘密情報を直接置かない。`secret-actuator`（OS keychain）か環境変数が原則。

## 3. 配置先一覧

| ファイル | 顧客オーバーレイ | 個人フォールバック | 公開デフォルト |
|---|---|---|---|
| identity | `identity.json` | `my-identity.json` | — |
| vision | `vision.md` | `my-vision.md` | — |
| connections | `connections/*.json` | `connections/*.json` | — |
| voice | `voice/profile.json` | `voice/profile-registry.json` | `voice/*` |
| 承認ポリシー | `policy/approval-policy.json` | — | `governance/approval-policy.json` |
| ミッション seed | `mission-seeds/*.json` | — | (additive のみ) |

## 4. 既存 1 ユーザ設定からの移行

`knowledge/personal/` をそのまま使い続けて構わない（`KYBERION_CUSTOMER` 未設定で動作）。

顧客オーバーレイ構造に変換する場合:

```bash
pnpm customer:create my-org
export KYBERION_CUSTOMER=my-org
```

## 5. Resolver API

```typescript
import { customerResolver } from '@agent/core';

const slug = customerResolver.activeCustomer();
const path = customerResolver.customerRoot('connections/slack.json');
const resolved = customerResolver.resolveOverlay('connections/slack.json');
const { overlay, base } = customerResolver.overlayCandidates('policy/approval-policy.json');
```

## 6. Out of Scope（後続タスク）

- セッション内での顧客切替（プロセス再起動が必要）
- 同時多顧客実行（プロセス分離が必要）
- 顧客スコープの trace 保存（B-1 で対応予定）

## 7. 既存 tier システムとの関係

顧客オーバーレイは既存 3-tier の **追加レイヤ**、置き換えではない。tier hygiene（confidential → public への漏洩禁止）は従来通り。顧客オーバーレイは `personal` と同じ信頼レベルとして扱う。

## 8. 実装状況

- [x] ディレクトリ構造
- [x] Resolver API + テスト
- [x] `pnpm customer:create`
- [x] `customer:list`
- [x] `customer:switch`
- [x] onboarding wizard 統合
- [x] 移行ヘルパ
- [ ] 各 caller のオーバーレイ対応
  - [x] connections consumer (`libs/core/service-engine.ts`)
  - [x] policy consumer (`libs/core/approval-policy.ts`)
  - [x] mission seeds consumer (`libs/core/mission-seed-registry.ts`)
  - [x] voice profile registry consumer (`libs/core/voice-profile-registry.ts`)
  - [x] vital check consumer (`scripts/vital_check.ts`)
  - [x] baseline check consumer (`scripts/run_baseline_check.ts`)
  - [x] onboarding apply consumer (`scripts/onboarding_apply.ts`)
  - [x] slack onboarding consumer (`libs/core/slack-onboarding.ts`)
