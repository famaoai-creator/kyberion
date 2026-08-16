---
title: CLI-Anything Service Harness 統合改善計画
tags: [service-actuator, service-harness, cli-anything, adapter, verification]
last_updated: 2026-08-16
status: implemented
---

# CLI-Anything Service Harness 統合改善計画

## 目的

CLI-Anything の自己記述・operation単位のCLI・JSON出力・dry-run・実体検証の考え方を、Kyberionの既存の `service-actuator`、service preset、adapter、ADF、approval、tenant/mission scopeに接続する。

CLI-AnythingのCLI実装を複製するのではなく、既存のservice engineを唯一の実行境界として維持し、サービス操作をエージェントが安全に発見・計画・検証できる契約を追加する。

## 成功条件

1. service presetのoperationが、入力・リスク・adapter候補・検証方法を機械的に記述できる。
2. サービスとoperationのsummary/detailを、同じcanonical registryから生成できる。
3. 外部副作用のない `describe`、`plan`、`verify`、`receipt` をservice actuatorから実行できる。
4. `plan` が必須入力、read/writeリスク、approval要否、実行候補をJSONで返す。
5. `receipt` が入力をredactし、実行結果を生のsecretやpayloadなしで記録できる。
6. 既存の `PRESET` / `API` / `CLI` / `MCP` / `OAUTH` / `RECONCILE` の契約を壊さない。
7. schema、adapter、service actuatorの契約テストが、開発者マシンのcredentialや実サービスに依存せず通過する。

## 設計原則

### 実行境界

```text
surface / agent
    ↓ describe / plan / execute contract
service harness resolver
    ↓ validated service operation
ADF / mission / approval / tenant scope
    ↓
service-actuator
    ↓
service-engine → API / governed CLI / MCP / SDK
```

`describe` と `plan` は副作用を持たない。外部副作用を持つ `execute` は既存のADF・mission・approval経路を通り、Service Harnessは実行経路を横取りしない。

### 外部書き込みの扱い

CLI-Anythingのローカルプロジェクト向けundo/redoは、外部サービス操作には一般化しない。外部書き込みには、次を使う。

- approval gate
- idempotency key
- normalized result
- postcondition verification
- redacted execution receipt
- 可能な場合のcompensation operation

### CLI fallbackの安全性

任意の `service_id + Object.values(params)` をCLI引数にするfallbackは新しいService Harnessの標準にしない。CLIはpresetに明示された、検証済みのcommand/args/envだけを実行する。

## 実装フェーズ

### Phase 1 — Operation契約とcanonical registry

- service preset schemaにoperationの `risk`、`kind`、`idempotency`、`verification`、parameter schemaを追加
- 既存presetとの後方互換を維持するnormalizerを追加
- 必須parameter、型、method、alternativeを検証

### Phase 2 — Describe / Plan / Verify / Receipt

- `describeServiceHarness` を追加
- `planServiceOperation` を追加
- redacted inputと実行候補を含むplanを返す
- 結果のpostconditionを検証する
- receiptを `active/shared/runtime/service-receipts/` に安全に保存できるようにする

### Phase 3 — Service actuator接続

- service actuatorに副作用のない `HARNESS` modeを追加
- `describe`、`plan`、`verify`、`receipt` をdispatch
- 既存の外部実行modeの戻り値と挙動は維持

### Phase 4 — 生成surfaceと段階的開示

- `service-harness-registry.json` をservice presetから生成
- summary registryからdetail参照とoperation metadataを段階的に開示
- CLI surfaceはregistryを再実装せず、service actuatorのresolver出力を利用

### Phase 5 — 検証と拡張

- GitHub / Slackのpresetを対象にcontract testを追加
- `service:harness` CLIでcredential不要のdescribe/plan/verify/receipt smoke testを提供
- local service（ComfyUI等）へのpreview/session/trajectory拡張と、credential付き実サービスE2Eは次段階の拡張候補として整理

## 今回の受入範囲

本変更ではPhase 1〜5の基盤を実装した。実サービスへの外部副作用を伴うE2E、ComfyUI等のtrajectory拡張、capability bundleやSKILLへの詳細なoperation参照の展開は、既存の実行境界を維持したまま次段階で追加する。

検証コマンド:

- `pnpm vitest run libs/core/service-harness.test.ts libs/actuators/service-actuator/src/index.test.ts`
- `pnpm run generate:service-harness-registry`
- `pnpm run check:service-harness-registry`
- `pnpm run service:harness -- --service github --action describe --detail false`
- `pnpm run check:contract-schemas`
- `pnpm run check:catalogs`
- `pnpm run typecheck`
- `git diff --check`

## 参照

- CLI-Anything: `active/shared/tmp/CLI-Anything/cli-anything-plugin/HARNESS.md`
- Kyberion adapter policy: `knowledge/product/governance/adapter-first-extension-policy.md`
- Kyberion capability disclosure: `knowledge/product/orchestration/capability-bundle-progressive-disclosure.md`
- Kyberion service preset schema: `knowledge/product/schemas/service-presets.schema.json`
