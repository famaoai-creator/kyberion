---
title: 顧客集約ポイント
category: Developer
tags: [fde, customer, configuration, aggregation]
importance: 9
last_updated: 2026-11-06
---

# 顧客集約ポイント

Kyberion を fork せずに、1 つのチェックアウトを複数の主体として運用するための設定分離機構。

## 現在の v2 契約（ドラフト）

stance（運用主体）、tenant（機密境界）、tenant 自身の顧客は別の概念です。`customer/` は移行元の旧保存先です。現在のテンプレートは `templates/stance/` を使います。後半の旧設計は履歴であり、現在の配置や操作手順ではありません。

| 用途                                  | 現在の配置 / API                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| stance 設定                           | `knowledge/personal/stances/{stance}/`、`stance.json`。有効化は `KYBERION_STANCE` |
| tenant の会社情報                     | `knowledge/confidential/{tenant}/`、`company.json`                                |
| tenant の案件・文書・エスカレーション | `knowledge/confidential/{tenant}/deals/`                                          |
| stance のトレース                     | `active/shared/logs/stances/{stance}/traces/`                                     |
| tenant 監査ミラー                     | `active/shared/runtime/audit-mirror/confidential/{tenant}/`                       |

```ts
import {
  activeStance,
  stanceRoot,
  resolveOverlay,
  overlayCandidates,
} from '@agent/core/stance-resolver';
import { tenantHomePath } from '@agent/core/organization/tenant-registry';

const stance = activeStance();
const connection = stanceRoot('connections/slack.json');
const company = tenantHomePath('acme-corp', 'company.json');
```

旧 API `activeCustomer` / `customerRoot` は `activeStance` / `stanceRoot` に変わります。stance の選択やパスの解決は権限を付与しません。tenant の I/O は tenant に束縛した facade と secure I/O を通します。汎用ヘルパーは `@agent/core/foundation/text` などの公開 foundation subpath、ドメイン API は公開ドメイン subpath を使い、内部ファイルを直接 import しません。

### 移行順序と互換性

`pnpm migration --dry-run` の計画を確認してから、以下の順に適用します。

| 移行               | 旧保存先 → 現在の保存先                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001-stance-home` | `customer/{slug}/` の stance 設定 → `knowledge/personal/stances/{slug}/`。旧 `customer.json` から `stance.json` を生成。トレース → `active/shared/logs/stances/{slug}/traces/` |
| `0002-tenant-home` | `customer/{tenant}/` の会社情報 → `knowledge/confidential/{tenant}/`。`customer.json` → `company.json`。監査ログ → confidential の監査ミラー                                   |
| `0003-deal-home`   | `customer/{tenant}/deals/` → `knowledge/confidential/{tenant}/deals/`。JSON / JSONL 内の参照も更新                                                                             |

旧 v1 の配置と resolver は stable 契約でした。本変更は root / core の major version 更新を必要とする v2 提案です。[Extension Points §6](./EXTENSION_POINTS.md#6-deprecation) の最低90日の非推奨期間は **満たしていません**。公開は **ドラフト**、maintainer による例外判断は **未決定** であり、承認済みではありません。この文書は実データの移行を実行したことを意味しません。

## 旧 v1 設計の記録（履歴のみ）

以下は旧設計と API 例を履歴として残したものです。旧コマンド、パス、resolver 名、完了チェックリストは現在の操作手順ではありません。現在の利用方法は [stance テンプレート](../../templates/stance/README.md) と [stance / tenant / customer モデル](../../knowledge/product/architecture/stance-tenant-customer-model.md) を参照してください。

### 1. 課題

従来の Kyberion は customer overlay がないレガシー単一利用前提:

- `knowledge/personal/` — レガシーフォールバック
- `knowledge/confidential/{tenant-slug}/` — テナント単位（機密境界 1 つ）
- `knowledge/public/` — 再利用可能

FDE 案件では:

1. 同一 Kyberion インストールで複数顧客を扱う必要がある
2. 顧客 A と B の identity / connections / policy を完全分離する必要がある
3. fork なしで顧客導入を 80% 以上「設定」で吸収したい

### 2. 設計

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

#### 2.1 アクティブ化

```bash
export KYBERION_STANCE=acme-corp
```

未設定時は既存の `knowledge/personal/` をレガシーフォールバックとして使う（後方互換）。

#### 2.2 解決順序

1. `knowledge/personal/stances/{slug}/{path}`（顧客オーバーレイ）
2. `knowledge/personal/{path}`（個人フォールバック）
3. `knowledge/public/{path}`（公開デフォルト、policy 等）

最初に見つかったパスを返す。書き込み時は customer 有効ならオーバーレイ側に書く。

#### 2.3 slug 制約

```
^[a-z0-9][a-z0-9_-]*$
```

パストラバーサル（`..` / `/`）は拒否。検証は `libs/core/customer-resolver.ts` 経由必須。

#### 2.4 秘密情報

`knowledge/personal/stances/{slug}/` は gitignored だが、それでも秘密情報を直接置かない。`secret-actuator`（OS keychain）か環境変数が原則。

### 3. 配置先一覧

| ファイル        | 顧客オーバーレイ              | 個人フォールバック            | 公開デフォルト                    |
| --------------- | ----------------------------- | ----------------------------- | --------------------------------- |
| identity        | `identity.json`               | `my-identity.json`            | —                                 |
| vision          | `vision.md`                   | `my-vision.md`                | —                                 |
| connections     | `connections/*.json`          | `connections/*.json`          | —                                 |
| voice           | `voice/profile.json`          | `voice/profile-registry.json` | `voice/*`                         |
| 承認ポリシー    | `policy/approval-policy.json` | —                             | `governance/approval-policy.json` |
| ミッション seed | `mission-seeds/*.json`        | —                             | (additive のみ)                   |

### 4. 既存 1 ユーザ設定からの移行

`knowledge/personal/` をそのまま使い続けて構わない（`KYBERION_STANCE` 未設定で動作）。

顧客オーバーレイ構造に変換する場合:

```bash
pnpm stance:create my-org
export KYBERION_STANCE=my-org
```

### 5. Resolver API

```typescript
import { customerResolver } from '@agent/core';

const slug = customerResolver.activeCustomer();
const path = customerResolver.customerRoot('connections/slack.json');
const resolved = customerResolver.resolveOverlay('connections/slack.json');
const { overlay, base } = customerResolver.overlayCandidates('policy/approval-policy.json');
```

### 6. Out of Scope（後続タスク）

- セッション内での顧客切替（プロセス再起動が必要）
- 同時多顧客実行（プロセス分離が必要）
- 顧客スコープの trace 保存（B-1 で対応予定）

### 7. 既存 tier システムとの関係

顧客オーバーレイは既存 3-tier の **追加レイヤ**、置き換えではない。tier hygiene（confidential → public への漏洩禁止）は従来通り。顧客オーバーレイは `personal` と同じ信頼レベルとして扱う。

### 8. 実装状況

- [x] ディレクトリ構造
- [x] Resolver API + テスト
- [x] `pnpm stance:create`
- [x] `stance:list`
- [x] `stance:switch`
- [x] onboarding wizard 統合
- [x] 移行ヘルパ
- [ ] 各 caller のオーバーレイ対応
  - [x] connections consumer (`libs/core/service/service-engine.ts`)
  - [x] policy consumer (`libs/core/governance/approval-policy.ts`)
  - [x] mission seeds consumer (`libs/core/mission/mission-seed-registry.ts`)
  - [x] voice profile registry consumer (`libs/core/voice/voice-profile-registry.ts`)
  - [x] vital check consumer (`scripts/vital_check.ts`)
  - [x] baseline check consumer (`scripts/run_baseline_check.ts`)
- [x] onboarding apply consumer (`scripts/onboarding_apply.ts`)
- [x] slack onboarding consumer (`libs/core/integrations/slack-onboarding.ts`)
  - [x] mission prerequisites / creation consumer (`libs/core/mission/mission-state.ts`, `libs/core/mission/mission-creation.ts`, `libs/core/mission/mission-llm.ts`)
