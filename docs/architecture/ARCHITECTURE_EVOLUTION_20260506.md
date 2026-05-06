# Kyberion Architecture Evolution Log — 2026-05-06

この記録は、2026-05-06 に実施した tenant/confidential 境界と契約検証の整理を残すためのものです。

## 概要

Kyberion の `knowledge/confidential/` 境界と契約検証を、`tenant_slug` と governed schema を基準に整理しました。  
加えて、サービス接続の readiness、mission-state の broker 期限、baseline の drift 検査を実装し、public tier に環境依存値を残さない方向へ寄せています。

## 実施した変更

- `knowledge/confidential/` の tenant 境界を `tenant_slug` 基準に統一
- `security-policy.json` に `tenant_scope` を追加し、broker 許可条件を明示化
- `mission-state` に `cross_tenant_brokerage.expires_at` を追加し、保存時に schema 検証を導入
- `service-connection-readiness` を governance schema として外出しし、baseline check に組み込み
- `tier-guard` / `authority` / `service-engine` / `secure-io` の接続経路を policy 駆動で整備
- ComfyUI / Whisper / Meeting の preset を整理し、環境依存値を public tier に残さない形へ寄せた

## 追加の整理

- `path-scope-policy.json` は `${TENANT_SLUG}` に寄せ、tenant 境界の判定キーを統一
- `tenant-profile.schema.json` で `tenant_slug` を必須化
- `service-connection-readiness.schema.json` を追加し、運用設定の型安全性を上げた
- `check_contract_schemas.ts` に `mission-state` と `service-connection-readiness` を追加した
- `comfyui-status-check` などの fragment を、未解決テンプレート前提から外した

## 検証

- `pnpm build`
- `pnpm pipeline --input pipelines/baseline-check.json`
- `pnpm vitest run libs/core/tier-guard-tenant.test.ts`
- `pnpm tsx scripts/check_contract_schemas.ts`

## 運用メモ

- 変更は PR `#269` として統合済み
- ワークツリーの生成物は整理済みで、現在はクリーン状態
- 以後は `tenant_slug` と `brokerApproval` を tenant 境界の基準として扱う
