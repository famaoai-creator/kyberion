---
title: テナント追加手順 — 登録は1系統、検証は check:tenant-registry
category: Governance
tags: [governance, tenant, onboarding, da-01, tenant-registry]
importance: 8
last_updated: 2026-08-15
kind: governance
scope: repository
authority: standard
---

# テナント追加手順（DA-01）

この文書は registry profile の登録だけを扱う。organization の binding、activation probe、
first-work の開始までを含む標準順序は [オンボーディング標準フロー](./onboarding-flow.md) を参照する。

テナントの正本(背骨)は **テナントプロファイル**(`libs/core/tenant-registry.ts` が読む
`knowledge/personal/tenants/{slug}.json`)である。`customer/{customer}/tenants/{tenant}.json`
は customer stance 側の任意の参照ファセットであり、`KYBERION_CUSTOMER` の切替で正本が
変わってはならない。他の系統
(`knowledge/confidential/tenants/index.json`・`customer/{slug}/` ディレクトリ)は
任意の付随ファセットであり、**登録はプロファイル1系統だけ**行い、残りは突合スクリプトで検証する。

## 手順

1. **facade から dry-run を実行する。** 手動 JSON 編集は禁止する。
   `pnpm tenant create example-co --display-name "Example Co."` を実行し、
   出力された profile path と knowledge root を確認する。

   ```bash
   pnpm tenant create example-co --display-name "Example Co." --assigned-role advisor --apply
   pnpm tenant show example-co --json
   ```

   - `knowledge_root` は省略時 `knowledge/confidential/{slug}` に解決される(明示も可)。
   - `ingest_sources[]` はこのテナントの取込元宣言(DA-02 以降が参照)。

2. **突合スクリプトで検証する。**

   ```bash
   pnpm run check:tenant-registry
   # ビルド前なら: node --import ./scripts/ts-loader.mjs scripts/check_tenant_registry_consistency.ts
   ```

   全系統の slug 集合を突合し、per-slug の表を出してドリフトがあれば非0で終了する。
   CI でも同名ゲートが常時実行される。

3. **解決を確認する。**
   `resolveTenant(slug)`(`@agent/core`)が active プロファイル・`knowledge_root`・
   customer overlay(`customer/{slug}/` が存在する場合)を一意に返せば完了。
   `suspended`/`archived` は tenant-bound write を fail-closed で拒否する。

## 意図的な非対称(例外)の扱い

テスト用 sink・scaffold テンプレート・デモ用ディレクトリなど、テナントではない slug が
他系統に現れる場合は、削除せず
`knowledge/product/governance/tenant-registry-exceptions.json` に
**1行の理由付き**で例外登録する。理由のない例外・重複例外は突合スクリプトが拒否する。

## やってはいけないこと

- confidential index や `customer/{slug}/` への「登録だけ」でテナントを増やすこと
  (プロファイルなしの slug はドリフトとして CI が落とす)。
- facade を経由しない profile JSON の直接編集。
- 例外ファイルの理由なしエントリ。

関連: [TENANT_DATA_ACTIVATION_PLAN_2026-07-28](../../../docs/developer/improvement-plans-2026-07/TENANT_DATA_ACTIVATION_PLAN_2026-07-28.ja.md) DA-01
