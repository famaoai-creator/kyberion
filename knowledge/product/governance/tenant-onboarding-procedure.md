---
title: テナント追加手順 — 登録は1系統、検証は check:tenant-registry
category: Governance
tags: [governance, tenant, onboarding, da-01, tenant-registry]
importance: 8
last_updated: 2026-07-28
kind: governance
scope: repository
authority: standard
---

# テナント追加手順（DA-01）

テナントの正本(背骨)は **テナントプロファイル**(`libs/core/tenant-registry.ts` が読む
`knowledge/personal/tenants/{slug}.json`、`KYBERION_CUSTOMER` 設定時は
`customer/{slug}/tenants/{slug}.json`)である。他の系統
(`knowledge/confidential/tenants/index.json`・`customer/{slug}/` ディレクトリ)は
任意の付随ファセットであり、**登録はプロファイル1系統だけ**行い、残りは突合スクリプトで検証する。

## 手順

1. **プロファイルを1件登録する。**
   `knowledge/personal/tenants/{slug}.json` を作成する
   (スキーマ: `knowledge/product/schemas/tenant-profile.schema.json`。
   slug は `^[a-z][a-z0-9-]{1,30}$`)。

   ```json
   {
     "tenant_slug": "example-co",
     "tenant_id": "example-co",
     "display_name": "Example Co.",
     "status": "active",
     "assigned_role": "advisor",
     "isolation_policy": { "strict_isolation": true, "allow_cross_distillation": true },
     "ingest_sources": [{ "source_system": "confluence", "enabled": true }]
   }
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
   `resolveTenant(slug)`(`@agent/core`)がプロファイル・`knowledge_root`・
   customer overlay(`customer/{slug}/` が存在する場合)を一意に返せば完了。

## 意図的な非対称(例外)の扱い

テスト用 sink・scaffold テンプレート・デモ用ディレクトリなど、テナントではない slug が
他系統に現れる場合は、削除せず
`knowledge/product/governance/tenant-registry-exceptions.json` に
**1行の理由付き**で例外登録する。理由のない例外・重複例外は突合スクリプトが拒否する。

## やってはいけないこと

- confidential index や `customer/{slug}/` への「登録だけ」でテナントを増やすこと
  (プロファイルなしの slug はドリフトとして CI が落とす)。
- 既存データの削除によるドリフト解消(登録追加 or 例外登録で解消する)。
- 例外ファイルの理由なしエントリ。

関連: [TENANT_DATA_ACTIVATION_PLAN_2026-07-28](../../../docs/developer/improvement-plans-2026-07/TENANT_DATA_ACTIVATION_PLAN_2026-07-28.ja.md) DA-01
