# Capability Lifecycle Procedure

Kyberion における、`provider` / `gateway` / `platform` のような lifecycle-bearing object を共通の骨格で扱うための手順定義。

## Purpose

この procedure は、対象ごとの中身を統一するものではない。  
統一するのは、`discover -> normalize -> register -> reconcile -> activate -> observe -> refresh -> retire` という管理の流れである。

## Machine-readable spec

- [capability-lifecycle-procedure.json](../governance/capability-lifecycle-procedure.json)

## When to apply

- [Capability Lifecycle Eligibility Checklist](./capability-lifecycle-eligibility-checklist.md)

## What this gives us

- capability / gateway / platform で同じ管理語彙を使える
- scan / register / reconcile / refresh / retire を同じ枠で扱える
- execution receipt と監査の必須項目を揃えやすい
- provider ごとの差分は plugin / adapter 側に残せる

## What this does not do

- probe の具体手順を統一しない
- approval の厳しさを一律化しない
- fallback の先を固定しない
- runtime ownership を消し込まない

## Related

- [Mission Workflow Catalog](../governance/mission-workflow-catalog.json)
- [Standard Intents](../governance/standard-intents.json)
- [Provider Capability Scan Framework](./provider-capability-scan-framework.md)
- [Provider Native Capability Bridge](./provider-native-capability-bridge.md)
- [Agent Runtime Observability Model](./agent-runtime-observability-model.md)
