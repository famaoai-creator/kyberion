---
title: Pipeline 動作確認インベントリ 2026 10 17
tags: [improvement-plan, 2026-10]
last_updated: 2026-10-18
status: active
---

# Pipeline 動作確認インベントリ — 2026-10-17

`pipelines/` に用意されている pipeline のうち、**過去に作成されたが動作確認されていないもの**を
洗い出し、副作用のないものは実際に実行検証して、事実と次アクションを 1 枚にまとめる。

## 1. 調査方法

- 対象: `pipelines/**/*.json` の **118 本**（`fragments/` 78 本は部品のため除外）。
- 「動作確認の証跡」は次のいずれかが存在するかで判定した。

| 証跡源                  | 場所                                                                                                                                               | 保持期間     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| スケジュール実行        | `active/shared/runtime/pipeline-schedules.json` の `lastRun` / `lastStatus`                                                                        | 現在         |
| 実行トレース            | `active/shared/logs/traces/*.jsonl`                                                                                                                | 2026-09-18〜 |
| 実行ジャーナル          | `active/shared/runtime/pipeline-runs/*.jsonl`                                                                                                      | 2026-08-28〜 |
| docs-only 分類（OW-07） | `knowledge/product/governance/orphan-baseline.json`                                                                                                | 現在         |
| 過去監査                | [AR-08_PIPELINE_CATALOG_AUDIT](../improvement-plans-archive/2026-07/AR-08_PIPELINE_CATALOG_AUDIT.ja.md)（2026-07-14、77 本中 55 実行 / 22 未実行） | 静的         |

> ⚠️ 実行テレメトリは 2026-08-28 以降しか残っていない。AR-08（7 月）で実行済みの pipeline は
> 現在「証跡なし」に見えるため、**「証跡なし」は「一度も実行していない」と同義ではない**。
> 最も確度が高いのは「AR-08 で未実行と明記され、今も証跡がない」群（後述 ①）。

## 2. 全体分類（118 本）

| 区分                                                      | 本数 |
| --------------------------------------------------------- | ---- |
| A. 実行成功の証跡あり（スケジュール成功 19 + 手動実行 5） | 24   |
| B. 実行したが失敗中                                       | 7    |
| C. 一度も実行の証跡なし                                   | 87   |
| └ C-1. スケジュール登録済みだが未発火                     | 14   |
| └ C-2. スケジュールなし・実行証跡なし                     | 73   |
| 　　（うち公式に「docs-only＝実行経路なし」= 32）         |      |

補足: 全 118 本は schema / guardrails の**静的検証は通っている**
（`tests/pipeline-adf-contract.test.ts`）。欠けているのは「実行して動くことの確認」。

## 3. 未検証候補

### ① AR-08(2026-07) で未実行 → 今も証跡なし（12 本・最有力）

`kyberion-autonomous-onboarding`, `launch-first-run-onboarding`, `platform-onboarding`,
`voice-onboarding`, `create-my-avatar`, `setup-oauth`, `soak-restart-e2e`,
`chaos-network-partition`, `chaos-secret-missing`, `generate-masterclass-pptx`,
`kyberion-vtuber-narrated-demo`, `trial-narrated-report`

（同時期の `storage-janitor` / `soak-endurance` / `backup-restore-drill` はその後
スケジュール登録され実行実績が付いた。`kyberion-config-provisioner` / `chaos-repair-test` は退役済み。）

### ② スケジュール登録済みだが一度も発火していない（14 本）

`exposure-check`, `ops-health-probe`, `knowledge-hygiene-probe`, `meeting-watcher`,
`organization-daily-digest`, `organization-operation-tick`, `organization-standup`,
`organization-retro`, `pr-shadow-observer`, `reconcile-config-fallbacks`,
`reconcile-unclassified-errors`, `reconcile-unhandled-intents`, `soak-endurance`, `soak-endurance-live`

→ すべて `enabled: false` / opt-in。**設定ミスではなく意図的に未稼働**（既知の事実）。

### ③ 実行したが現在失敗中（7 本）

`action-item-reminders`, `ai-audit`, `backup-daily`, `backup-restore-drill`, `ce-chronos-perf`,
`knowledge-curation-weekly`, `mission-hygiene-weekly`

→ 「動作確認はされたが動いていない」。別途の失敗解析対象。

### ④ docs-only（OW-07 orphan baseline＝実行経路なし、32 本）

`agent-provider-check`, `browser-failure-evidence`, `ceo-strategic-report`, `chaos-actuator-down`,
`chaos-network-partition`, `chaos-secret-missing`, `cloudflare-os-validation`, `external-asset-ledger`,
`generate-design-system-demo`, `generate-masterclass-pptx`, `incident-review`, `inspect-system-hardware`,
`kyberion-autonomous-onboarding`, `kyberion-product-intro`, `media-produce-and-review`,
`media-review-fix-validation`, `meeting-hearing-session`, `meeting-tutor-session`, `mission-team-prewarm`,
`mission-team-staff`, `open-active-surfaces`, `orchestration-jobs`, `platform-onboarding`,
`project-management-validation`, `setup-oauth`, `soak-restart-e2e`, `source-to-engineering-artifacts`,
`surface-capability-check`, `terraform-asset-inventory`, `terraform-topology-ir`,
`test-inventory-device-pipeline`, `trial-narrated-report`

→ 「手動実行のみ・実行経路なし」と公式に分類済み（README 記載の手順で人手実行する想定）。

## 4. 実行検証（2026-10-17 実施）

副作用のない読み取り系を中心に **13 本** を実際に `pnpm pipeline` で実行した。
結果は **成功 11 / 環境要因の失敗 2**。

| pipeline                      | 結果       | 備考                                                                    |
| ----------------------------- | ---------- | ----------------------------------------------------------------------- |
| `inspect-mission-inventory`   | ✅ SUCCESS | `system:log` が object を `[object Object]` 表示（後述 ③・修正済み）    |
| `surface-capability-check`    | ✅ SUCCESS |                                                                         |
| `verify-session-fallback`     | ✅ SUCCESS | `active/shared/tmp/` に artifact 生成                                   |
| `service-lifecycle-smoke`     | ✅ SUCCESS | inspect のみ                                                            |
| `aws-operations-simulation`   | ✅ SUCCESS | 検証用 change-plan を渡して dry-run 生成を確認                          |
| `full-health-report`          | ✅ SUCCESS | 3 sub-pipeline を集約                                                   |
| `list-capabilities`           | ✅ SUCCESS | 検証時は persona 明示が必要（後述 ①）。①修正後は persona 未設定でも成功 |
| `inspect-system-hardware`     | ✅ SUCCESS | 同上                                                                    |
| `inspect-workspace-surfaces`  | ✅ SUCCESS | 同上                                                                    |
| `inspect-network-environment` | ✅ SUCCESS | 同上                                                                    |
| `monitor-service-health`      | ✅ SUCCESS | 同上                                                                    |
| `agent-provider-check`        | ❌ FAIL    | `KYBERION_ALLOW_UNSAFE_SHELL` 未設定（環境ゲート、後述 ④）              |
| `meeting-hearing-session`     | ❌ FAIL    | persona 未解決で write policy 拒否（後述 ②）                            |

> reasoning 系 5 本は、検証当時は `KYBERION_PERSONA=default` を明示すると成功した。つまり
> **pipeline 自体は正常で、失敗は環境側の不具合**であった（①）。①修正後は persona 未設定でも成功する。

## 5. 検証で判明した不具合

1. **`persona="unknown"` が reasoning role に漏れる（重要・2026-10-17 修正済み）**
   未オンボーディング環境では `resolveIdentityContext().persona === 'unknown'` が truthy のため
   `scripts/pipeline-execution-part-results.ts:386` がそのまま `KYBERION_PERSONA=unknown` を登録し、
   `reasoning-route-resolver.ts` が persona を reasoning role として解釈して
   `Unknown reasoning role "unknown"` で失敗していた。
   影響: **未オンボーディング環境では `reasoning:*` を使う全 pipeline が動かない**。
   調査で `worker` / `sovereign` / `mission_owner` / `analyst` といった権威 persona でも同じ失敗を
   再現し、真因は **persona と reasoning role の語彙混同**（両者は別物）と判明した。

   修正（作業ツリー・未コミット）:
   - `libs/core/reasoning/reasoning-route-resolver.ts`: `isReasoningRole()` を追加。
     `resolveStepReasoningRoute` は policy が定義する role のときだけ persona を role に使い、
     それ以外（`unknown`・権威 persona）は `default` へフォールバックする。
   - `scripts/pipeline-execution-part-bootstrap.ts`: `persona === 'unknown'` を `default` として扱い、
     `role` は有効な reasoning role のときだけ backend へ渡す。
   - `scripts/pipeline-execution-part-results.ts`: `unknown` を `KYBERION_PERSONA` として登録しない。
   - 回帰テスト: `libs/core/reasoning/reasoning-route-resolver.test.ts`
     （非 role persona→`default`、有効 role→その role の候補、`unknown` は非 role）。

   検証（実バンドル `pnpm pipeline`）: persona 未設定の `inspect-workspace-surfaces` = SUCCESS、
   `KYBERION_PERSONA=worker` の `list-capabilities` = SUCCESS（いずれも修正前は
   `Unknown reasoning role` で失敗）。`pnpm check -- --scope pr` は 48/48 パス、
   関連 vitest 123 件パス。

2. **meeting 系の write policy 拒否**: `meeting:hearing_session` が
   `[POLICY_VIOLATION] Persona 'unknown' ... NOT authorized to write to
'active/shared/observability/delegations.jsonl'` で失敗。①と同根（persona 未解決）。
3. **`system:log` の object 表示（軽微・2026-10-17 修正済み）**: `message: "{{channel}}"` が object に解決されると
   `String(object)` により `[object Object]` となり、payload 全体が落ちていた（`inspect-mission-inventory` で再現）。
   真因: `resolveVars` は全体テンプレート（`{{var}}` 単独）の型を保持するため、`system:log` 側の `String()` が
   object を潰していた。`resolveLogMessage` に object/array を pretty JSON へ整形する `formatLogPayload` を追加。
   回帰テスト: `scripts/run_pipeline.test.ts`（object→JSON、scalar/混在テンプレートは従来通り、未解決は空文字）。
   検証: `inspect-mission-inventory` の `system:log` が mission inventory の JSON を出力（`[object Object]` 消滅）。
4. **`agent-provider-check` は unsafe shell 前提**: provider-preflight fragment が
   `KYBERION_ALLOW_UNSAFE_SHELL=true` を要求。既定の sandbox では検証できない（環境依存として記録）。

## 6. 推奨アクション

- **短期**
  - ✅ ①の persona 伝播バグを修正済み（Persona が `unknown`／非 role のときは role へ流さない）。回帰テスト追加済み。
  - ✅ ③の `system:log` を object 対応（pretty JSON 化）に修正済み。回帰テスト追加済み。
- **中長期（恒久化）**
  - 実行検証を gate 化する: `tests/golden/pipelines.json` は現在 2 本のみ。
    読み取り系 pipeline を数本追加し、`run_pipeline_dry_run` を実行検証へ引き上げる。
  - ②は意図的未稼働のため現状維持（オプトインのまま）。③は失敗原因を別途トリアージ。
  - ④ docs-only 32 本は「実行経路なし」を維持するか、`AR-08` の残作業（静的レビュー／実行検証 or 退役）に
    沿って棚卸しする。
  - §7 のスコープ分類で「scope rule とのズレ 21 本」を識別済み。退役・テンプレート移行・
    `personal` 移設の判断材料に使う（正本: `pipeline-scope-registry.json`）。
- **退役・統合候補の洗い出し**は本レポートのスコープ外（別途トリアージ推奨）。

## 7. スコープ分類 — 「誰のための pipeline か」

背景: [`pipelines/README.md`](../../../pipelines/README.md) の **scope rule** は `pipelines/` を
「Kyberion 本体の自己運用のみ」と定め、ユーザー向け workflow は `knowledge/product/pipeline-templates/`、
テナント固有は `knowledge/confidential/{tenant}/pipelines/`、個人は `knowledge/personal/pipelines/` に置くと
宣言している。しかし実際の `pipelines/` にはユーザー向け・テナント向けの workflow が混在しており、
**どこに何があるかを名前から識別できない**。本節は全 118 本を 2 軸で識別する。

機械可読な正本: [`knowledge/product/governance/pipeline-scope-registry.json`](../../../knowledge/product/governance/pipeline-scope-registry.json)
（schema: `knowledge/product/schemas/pipeline-scope-registry.schema.json`）。
この分類は**トリアージ・文書化のためのもの**で、runtime は読まず、pipeline 本体（JSON）は一切変更していない。

### 7.1 audience — 誰のための pipeline か

| audience       | 本数 | 意味                                | 代表例                                                                                 |
| -------------- | ---- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `system`       | 74   | Kyberion 本体の自己運用             | `vital-check`, `backup-daily`, `system-upgrade-execute`, `ops-health-probe`            |
| `organization` | 14   | 組織の運用モデル／成果物            | `organization-standup`, `decision-digest`, `accountability-report-daily`, `sdlc-cycle` |
| `tenant`       | 7    | テナント（顧客）スコープ            | `tenant-ingest`, `tenant-drift-watch`, `external-asset-ledger`, `exposure-check`       |
| `personal`     | 15   | 個人のアシスタント作業              | `create-my-avatar`, `voice-onboarding`, `meeting-*`, `browser/*`                       |
| `product`      | 8    | Kyberion の対外デモ／マーケティング | `marketing-content`, `mv-generate`, `kyberion-product-intro`                           |

### 7.2 placement — scope rule 上どこに置くべきか

| placement                 | 本数 | 行き先                                                       |
| ------------------------- | ---- | ------------------------------------------------------------ |
| `canonical`               | 97   | `pipelines/`（`browser/`・`config/` を含む）に置くのが正しい |
| `should_be_template`      | 17   | `knowledge/product/pipeline-templates/` へ                   |
| `should_be_personal`      | 4    | `knowledge/personal/pipelines/` へ                           |
| `should_be_tenant_scoped` | 0    | （該当なし）`knowledge/confidential/{tenant}/pipelines/` へ  |

**scope rule とのズレは 21 本**（canonical 97 を除く）:

- **テンプレート行き 17 本**
  - meeting 系 6: `meeting-facilitation-workflow`, `meeting-followup`, `meeting-hearing-session`, `meeting-proxy-workflow`, `meeting-tutor-session`, `meeting-watcher`
  - product/GTM 8: `campaign-suite`, `generate-masterclass-pptx`, `kyberion-product-intro`, `kyberion-vtuber-narrated-demo`, `marketing-content`, `media-produce-and-review`, `mv-generate`, `trial-narrated-report`
  - organization 3: `ceo-strategic-report`, `executive-narrative-bridge`, `contract-review`（後者は `knowledge/product/pipeline-templates/contract-review.json` と**重複**）
- **personal 行き 4 本**: `create-my-avatar`, `voice-onboarding`, `daily-routine`, `weekly-review`

補足:

- `tenant` audience の 7 本は「システムが全テナントに対して回す**汎用ドライバ**」なので canonical のまま。
  テナント固有の instantiation が `knowledge/confidential/{tenant}/pipelines/` に置く対象。
- `browser/*`（`sbi`, `yahoo*`）は README の `browser/` 区分（記録ベース手順）なので canonical。
- 分類はレビュー前提の初期版であり、組織の解釈（例: meeting を organization と見るか personal と見るか）で
  変わりうる。変更はレジストリの `reason` を更新して行う。

## 付録: 全 118 本

列: `mtime`（最終更新日）、`schedule`（登録状態と最終ステータス）、`最終実行`、
`journal`/`trace`（実行証跡の件数）、`orphan基線`（docs-only か）、`検証(2026-10-17)`（本調査での実行結果）。

| pipeline                          | mtime      | schedule  | 最終実行   | journal | trace | orphan基線 | 検証(2026-10-17)       |
| --------------------------------- | ---------- | --------- | ---------- | ------- | ----- | ---------- | ---------------------- |
| `accountability-report-daily`     | 2026-10-01 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `action-item-reminders`           | 2026-10-17 | failed    | 2026-10-17 | 0       | 0     | -          | -                      |
| `agent-provider-check`            | 2026-10-03 | -         | -          | 0       | 0     | docs-only  | FAIL(env:unsafe-shell) |
| `agentic-source-code-review`      | 2026-08-23 | -         | -          | 0       | 0     | -          | -                      |
| `ai-audit`                        | 2026-09-07 | failed    | 2026-10-11 | 0       | 0     | -          | -                      |
| `approval-store-hygiene`          | 2026-10-06 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `assimilate-gateway-capability`   | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `audit-verify-daily`              | 2026-07-20 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `auto-checkpoint`                 | 2026-09-07 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `aws-operations-simulation`       | 2026-07-20 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `background-review-curator`       | 2026-07-20 | -         | -          | 0       | 0     | -          | -                      |
| `backup-daily`                    | 2026-09-07 | failed    | 2026-10-16 | 0       | 0     | -          | -                      |
| `backup-restore-drill`            | 2026-09-07 | failed    | 2026-09-30 | 0       | 0     | -          | -                      |
| `baseline-check`                  | 2026-10-05 | succeeded | 2026-10-17 | 1010    | 1     | -          | -                      |
| `browser-failure-evidence`        | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `sbi`                             | 2026-08-11 | -         | -          | 0       | 0     | -          | -                      |
| `yahoo`                           | 2026-08-11 | -         | -          | 0       | 0     | -          | -                      |
| `yahoo1`                          | 2026-08-11 | -         | -          | 0       | 0     | -          | -                      |
| `yahoo3`                          | 2026-08-11 | -         | -          | 0       | 0     | -          | -                      |
| `yahoo4`                          | 2026-08-11 | -         | -          | 0       | 0     | -          | -                      |
| `campaign-suite`                  | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `ce-chronos-perf`                 | 2026-09-07 | failed    | 2026-10-11 | 0       | 0     | -          | -                      |
| `ceo-strategic-report`            | 2026-07-24 | -         | -          | 0       | 0     | docs-only  | -                      |
| `chaos-actuator-down`             | 2026-07-20 | -         | -          | 0       | 0     | docs-only  | -                      |
| `chaos-network-partition`         | 2026-09-07 | -         | -          | 0       | 0     | docs-only  | -                      |
| `chaos-secret-missing`            | 2026-07-05 | -         | -          | 0       | 0     | docs-only  | -                      |
| `cloudflare-os-validation`        | 2026-09-07 | -         | -          | 0       | 0     | docs-only  | -                      |
| `surface-registration`            | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `tenant-onboarding`               | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `voice-engine-setup`              | 2026-07-05 | -         | -          | 0       | 0     | -          | -                      |
| `contract-review`                 | 2026-07-24 | -         | -          | 0       | 0     | -          | -                      |
| `cowork-integration-review`       | 2026-10-03 | -         | -          | 2       | 1     | -          | -                      |
| `create-my-avatar`                | 2026-09-27 | -         | -          | 0       | 0     | -          | -                      |
| `daily-routine`                   | 2026-09-07 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `decision-digest`                 | 2026-10-06 | succeeded | 2026-10-17 | 0       | 0     | -          | -                      |
| `dependency-vuln-scan`            | 2026-09-07 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `executive-narrative-bridge`      | 2026-07-24 | -         | -          | 0       | 0     | -          | -                      |
| `exposure-check`                  | 2026-10-13 | never     | never      | 0       | 0     | -          | -                      |
| `external-asset-ledger`           | 2026-10-13 | -         | -          | 0       | 0     | docs-only  | -                      |
| `first-win-lifecycle-weekly`      | 2026-09-07 | succeeded | 2026-10-12 | 0       | 0     | -          | -                      |
| `front-desk-request-receipt`      | 2026-10-05 | -         | -          | 0       | 0     | -          | -                      |
| `full-health-report`              | 2026-09-07 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `generate-design-system-demo`     | 2026-07-20 | -         | -          | 0       | 0     | docs-only  | -                      |
| `generate-masterclass-pptx`       | 2026-07-20 | -         | -          | 0       | 0     | docs-only  | -                      |
| `health-degradation-watch`        | 2026-09-07 | succeeded | 2026-10-17 | 0       | 0     | -          | -                      |
| `history-search-refresh`          | 2026-07-20 | succeeded | 2026-10-17 | 0       | 0     | -          | -                      |
| `i18n-drift-audit`                | 2026-10-01 | succeeded | 2026-10-11 | 0       | 0     | -          | -                      |
| `incident-review`                 | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `inspect-mission-inventory`       | 2026-09-07 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `inspect-network-environment`     | 2026-07-05 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `inspect-system-hardware`         | 2026-07-05 | -         | -          | 0       | 0     | docs-only  | SUCCESS                |
| `inspect-workspace-surfaces`      | 2026-09-07 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `knowledge-curation-weekly`       | 2026-10-08 | failed    | 2026-10-10 | 7       | 1     | -          | -                      |
| `knowledge-hygiene-probe`         | 2026-10-17 | never     | never      | 0       | 0     | -          | -                      |
| `knowledge-sync`                  | 2026-08-01 | -         | -          | 0       | 0     | -          | -                      |
| `kyberion-autonomous-onboarding`  | 2026-07-05 | -         | -          | 0       | 0     | docs-only  | -                      |
| `kyberion-product-intro`          | 2026-09-21 | -         | -          | 5       | 0     | docs-only  | -                      |
| `kyberion-vtuber-narrated-demo`   | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `launch-first-run-onboarding`     | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `list-capabilities`               | 2026-07-05 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `marketing-content`               | 2026-07-20 | -         | -          | 0       | 0     | -          | -                      |
| `media-produce-and-review`        | 2026-07-24 | -         | -          | 0       | 0     | docs-only  | -                      |
| `media-review-fix-validation`     | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `meeting-facilitation-workflow`   | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `meeting-followup`                | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `meeting-hearing-session`         | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | FAIL(env:persona)      |
| `meeting-proxy-workflow`          | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `meeting-tutor-session`           | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `meeting-watcher`                 | 2026-09-07 | never     | never      | 0       | 0     | -          | -                      |
| `mesh-delivery`                   | 2026-10-02 | -         | -          | 0       | 0     | -          | -                      |
| `mission-hygiene-weekly`          | 2026-09-29 | failed    | 2026-10-14 | 2       | 1     | -          | -                      |
| `mission-team-prewarm`            | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `mission-team-staff`              | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `monitor-service-health`          | 2026-10-03 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `mv-generate`                     | 2026-10-13 | -         | -          | 0       | 0     | -          | -                      |
| `open-active-surfaces`            | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `ops-health-probe`                | 2026-10-17 | never     | never      | 5       | 1     | -          | -                      |
| `orchestration-jobs`              | 2026-07-20 | -         | -          | 0       | 0     | docs-only  | -                      |
| `organization-daily-digest`       | 2026-10-03 | never     | never      | 0       | 0     | -          | -                      |
| `organization-operation-tick`     | 2026-10-05 | never     | never      | 0       | 0     | -          | -                      |
| `organization-retro`              | 2026-10-05 | never     | never      | 0       | 0     | -          | -                      |
| `organization-standup`            | 2026-10-05 | never     | never      | 0       | 0     | -          | -                      |
| `platform-onboarding`             | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `pr-shadow-observer`              | 2026-10-06 | never     | never      | 0       | 0     | -          | -                      |
| `project-management-validation`   | 2026-09-29 | -         | -          | 0       | 0     | docs-only  | -                      |
| `promote-procedure`               | 2026-10-03 | -         | -          | 0       | 0     | -          | -                      |
| `reconcile-config-fallbacks`      | 2026-10-01 | never     | never      | 0       | 0     | -          | -                      |
| `reconcile-unclassified-errors`   | 2026-10-01 | never     | never      | 0       | 0     | -          | -                      |
| `reconcile-unhandled-intents`     | 2026-10-01 | never     | never      | 0       | 0     | -          | -                      |
| `sdlc-cycle`                      | 2026-07-24 | -         | -          | 0       | 0     | -          | -                      |
| `service-lifecycle-smoke`         | 2026-09-07 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `setup-oauth`                     | 2026-09-07 | -         | -          | 0       | 0     | docs-only  | -                      |
| `soak-endurance-live`             | 2026-10-10 | never     | never      | 0       | 0     | -          | -                      |
| `soak-endurance`                  | 2026-09-07 | never     | never      | 0       | 0     | -          | -                      |
| `soak-restart-e2e`                | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `source-to-engineering-artifacts` | 2026-08-23 | -         | -          | 0       | 0     | docs-only  | -                      |
| `storage-janitor`                 | 2026-10-17 | succeeded | 2026-10-16 | 35      | 1     | -          | -                      |
| `surface-capability-check`        | 2026-07-20 | -         | -          | 0       | 0     | docs-only  | SUCCESS                |
| `system-diagnostics`              | 2026-07-05 | -         | -          | 2       | 1     | -          | -                      |
| `system-upgrade-check`            | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `system-upgrade-execute`          | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `tenant-drift-watch`              | 2026-09-07 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `tenant-ingest`                   | 2026-08-01 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `terraform-asset-inventory`       | 2026-10-13 | -         | -          | 0       | 0     | docs-only  | -                      |
| `terraform-topology-ir`           | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `test-inventory-device-pipeline`  | 2026-10-01 | -         | -          | 0       | 0     | docs-only  | -                      |
| `trial-narrated-report`           | 2026-10-03 | -         | -          | 0       | 0     | docs-only  | -                      |
| `ui-ux-governance-audit`          | 2026-09-07 | succeeded | 2026-10-11 | 0       | 0     | -          | -                      |
| `ui-voice-browser-smoke`          | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `verify-session-fallback`         | 2026-07-05 | -         | -          | 0       | 0     | -          | SUCCESS                |
| `verify-session`                  | 2026-07-05 | -         | -          | 7       | 1     | -          | -                      |
| `vital-check`                     | 2026-10-11 | -         | -          | 8       | 1     | -          | -                      |
| `voice-health-check`              | 2026-07-20 | -         | -          | 0       | 0     | -          | -                      |
| `voice-hello`                     | 2026-07-20 | -         | -          | 0       | 0     | -          | -                      |
| `voice-onboarding`                | 2026-09-07 | -         | -          | 0       | 0     | -          | -                      |
| `volatile-gc`                     | 2026-09-07 | succeeded | 2026-10-16 | 379     | 1     | -          | -                      |
| `volatile-index`                  | 2026-09-07 | succeeded | 2026-10-16 | 0       | 0     | -          | -                      |
| `weekly-review`                   | 2026-09-07 | succeeded | 2026-10-11 | 0       | 0     | -          | -                      |
