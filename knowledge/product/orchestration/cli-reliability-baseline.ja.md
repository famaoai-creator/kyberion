---
title: 'CLI Reliability Baseline — R00 接続表と証拠分類'
tags: [orchestration, cli, reliability, baseline]
last_updated: 2026-10-31
runtime_stages: [planning, execution]
---

# CLI Reliability Baseline (R00)

基準 SHA: `bfefd82b5d0b900506d5c4067bd78d47f737b1cd` (origin/main, PR #1311 merge)。
証拠: `tests/fixtures/cli-reliability/probes.json` (26 ケース分類)、`probe-log-round2.txt` (主 checkout `active/shared/tmp/cli-usability-20261031/`)。
凡例: ✅=基準コミットで file/symbol 確認済み / ❓=未確定 (該当 ticket で停止条件として扱う)。

## 0. 環境 metadata (非秘密)

- Node v26.12.1 / pnpm 11.15.1 / darwin arm64 / 永続 scope.env: tier=confidential, tenant=famao-ai, org=famao-ai, project=PRJ-KYBERION-PRODUCTIZATION
- reasoning backend: claude-cli failover chain / Apple Speech assets: ja_JP 未導入 / STT backend: whisperkit-cli 登録済み (list されるが実行 scope で失敗)
- 他プロセスの untracked 書込みが主 checkout に存在 (`libs/core/organization/judgment-precedents.*`) — 本調査では不触

## 1. R01〜R03 — confidential lifecycle 接続表

| 段階                  | entry (確認)                                                                                                | 引数/戻り値                                    | authority 発行元                         | scope 継承                                                                     | 読書き先                     | 失敗時                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| intake/admission      | ✅ `mission-creation.ts createMission/startMission` (132/549)                                               | args object → MissionState                     | caller context (`MISSION_ROLE`)          | --tier/tenant-slug 明示                                                        | `active/missions/<tier>/`    | SCOPE_CONTEXT_INVALID 等で throw                                                                                             |
| claim                 | ✅ `work-coordination.ts claimWorkItem` (714)                                                               | ClaimWorkItemInput → {item, lease}             | withCoordinationMutation 内で lease 発行 | envelope 内                                                                    | coordination store           | lease 競合/有効期限で throw                                                                                                  |
| credential dispatch   | ✅ `task-credential-dispatch.ts withConfiguredTaskCredentials`                                              | (workItemId, run) → T                          | `resolver.bindTask` (secret-resolver)    | envelope.identity vs runtime identity 一致検証。不一致→CREDENTIAL_SCOPE_DENIED | binding store (symbol-keyed) | resolver 無し/ binder 無し → unbound run (provider 側で fail-closed)                                                         |
| binding readiness     | ✅ `credential-binding.ts credentialBindingReadiness`                                                       | () → {status: bound/binding_required/operator} | —                                        | persisted scope.env or env or envelope                                         | —                            | tenant 有り+無 binding → binding_required (throw at installReasoningBackends)                                                |
| child context         | ✅ `execution-scope.ts runInExecutionScope` + `withTaskCredentialBinding`                                   | scope dict / binding → T                       | dispatcher が claim 所有下で構築         | tenantBound + tenantSlug                                                       | —                            | 不一致 → CREDENTIAL_SCOPE_DENIED                                                                                             |
| verify/distill/finish | ✅ `mission-lifecycle.ts verifyMission` (463), `finishMission` (681), `mission-distill.ts distillMission`   | (id, result, note)                             | mission owner                            | —                                                                              | mission dir + audit ledger   | controller の 'execution' 初期化で installReasoningBackends → 永続 tenant 下で binding_required (R03 の最初の失敗点、確認済) |
| scoped learning       | ✅ `memory-promotion-queue.ts enqueueMemoryPromotionCandidate` (514), `listMemoryPromotionCandidates` (679) | MemoryCandidate → id                           | distill 呼出側                           | MemoryScopeEnvelope                                                            | promotion queue store        | scope 不一致 candidate は queue 側で拒否 (要 R02 実証)                                                                       |
| review/ratification   | ❓ memory-approve の approval-channel=pr_review 必須は確認、pr merge 後の ratification 経路は未トレース     |                                                |                                          |                                                                                |                              | R02 で確認                                                                                                                   |

## 2. R04 — perception (listen) 接続表

| 要素              | entry (確認)                                                                                                            | scope 動作                                                                                                                 | 失敗時                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| scratch writer    | ✅ `scripts/lib/perception.ts createPerceptionWorkDir` (150)                                                            | `resolvePerceptionScope(source)` — active scope と入力推定 tier の高い方 → `active/shared/tmp/<tier>/<tenant>/perception/` | 上位 tier scratch へ書き込まれる設計自体は意図的                        |
| 変換 executor     | ✅ 同上 ffmpeg spawn (`listen` 実測で raw stderr 露出)                                                                  | 変換結果は confidential/famao-ai scratch へ                                                                                | 非音声入力を ffmpeg に直行 → Invalid data 露出 (invalid_input 分類なし) |
| bridge reader     | ✅ `transcribeWav` (231) + whisperkit-cli 呼出                                                                          | backend 実行 context が scratch の confidential scope を読めない → ROLE_VIOLATION (実測)                                   | 全 backend 失敗を 'backend 未導入' setup 文言へ一律変換 (誤 next)       |
| backend 選択/取消 | ❓ `speech-to-text-bridge.ts` registry — KYBERION_STT_COMMAND env と whisperkit-cli 検出の優先順位・cancel 経路は未確認 |                                                                                                                            | R04 で停止条件                                                          |
| local/cloud 境界  | ✅ `resolvePerceptionScope` は egress 無し表示 (see で egress none 実測)                                                |                                                                                                                            |                                                                         |

## 3. R07/R08 — index 読み vs private hydrate

| 要素                | entry (確認)                                                                     | 失敗時                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dot shared index    | ✅ `dot-action-ledger.ts readDotActionLedger` (150)                              | row 毎に hydratePrivateAction → 1行の scope/hash 不正で全体 throw (F5 実測)                                                                                                 |
| dot private hydrate | ✅ 同 `hydratePrivateAction` (119)                                               | scope 欠落/tier=public+private_hash → DOT_ACTION_CONTENT_UNAVAILABLE; personal 所有者不一致 → DOT_PERSONAL_OWNER。実行用途として fail-closed は正しいが観測用途への分離なし |
| intent mission 列挙 | ✅ `mission-state.ts listMissionsInSearchDirs` (638)                             | tier root lstat 拒否は suppressed warn で自家 partition probe に fallback — 列挙は生きる                                                                                    |
| intent state 解決   | ✅ `scripts/intent.ts collectIntentTraceReport` (402) → listMissions → loadState | 不可視 mission の loadState で OWNER_NOT_VISIBLE throw → trace 全体死亡 (実測)。列挙後の解決で scope 絞り込みが無い                                                         |

## 4. R11/R12 — build readiness 接続表

| 要素                    | entry (確認)                                                                                                                                                  | 判定                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| doctor repo-build probe | ✅ `environment-capability-probes.ts probeRepoBuild` (208)                                                                                                    | `newestTsMtimeUnder(libs/core)` (untracked 含む全 TS) vs `newestOutputMtimeUnder(dist)` + 5000ms grace。catch → available=true (unknown を green に落とす — 計画 §3.3 違反候補) |
| stale dist 別経路       | ✅ `check_stale_dist.ts`                                                                                                                                      | source_mtime/dist_file/tsbuildinfo 比較 — mtime 系だが emit 対応表あり (doctor より精密)                                                                                        |
| compiler output lock    | ✅ `build-coordination.ts withCompilerOutputs/tryInspectCompilerOutputs`                                                                                      | 成果物 read/write の lock。source 書込は止めない                                                                                                                                |
| build receipt           | ❓ `dist/.session-build-head` (agent-worktree stamp) が唯一の generation 痕跡。schemaVersion/fingerprint 付き receipt は未存在と思われる — R12 の設計確認対象 |
| knowledge manifest      | ✅ `build_repository.ts` が `generate_knowledge_index --manifest-only` step として実行                                                                        | receipt ではなく索引生成                                                                                                                                                        |

## 5. 26 プローブ分類サマリ (probes.json が正本)

- ok: 14 / expected_attention: 2 (doctor, vital) / expected_denial: 4 (unknown-cmd, calendar, email, list-check) / defect: 6 (listen×2, knowledge-rank, dot-status, read-missing 診断名, intent-trace)
- report 17/9 と raw 14/12 の差分: 未確定として記録 (KPI を exit0 数にしない方針)
- R1 で発見された範囲外ケース: `mission verify/distill/finish` が永続 tenant scope 下で binding_required — P27 として R01/R03 の fixture 対象に追加

## 6. 停止条件 (この段階で未確定な入口)

- R01: scoped learning の ratification 経路 (memory-approve → finish ratify) — fixture で再現可否が未確定 → 未確定なら该境界を blocked 報告
- R03: verify/distill/finish の各 adapter が推論を要する段階 — 実呼出トレース未実施 → R03 で最初の失敗位置をテスト確定
- R04: STT backend registry の選択/取消経路 — 未確認
- R12: 既存 receipt の実在確認 — `.session-build-head` 以外未発見
