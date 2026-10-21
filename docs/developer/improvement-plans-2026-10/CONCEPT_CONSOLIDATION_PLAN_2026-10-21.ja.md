---
title: '重複概念の切り出し計画 (CX-01〜08)'
tags: [improvement-plan, 2026-10, abstraction, duplication, concept, governance]
last_updated: 2026-10-21
status: partial
---

# 重複概念の切り出し計画 (CX-01〜08)

> **位置づけ**: [SIMPLICITY ABSTRACTION PLAN](../improvement-plans-2026-08/SIMPLICITY_ABSTRACTION_PLAN_2026-08-25.ja.md)(SX)の根本原因 **R1「共通化の種は存在するが採用されない」** の再測定。SX が「既存 helper へ寄せる」計画なのに対し、本計画は **正準が存在しない概念** を切り出す。
>
> **関連**: [SCOPE_GOVERNANCE_UNIFICATION_PLAN](./SCOPE_GOVERNANCE_UNIFICATION_PLAN_2026-10-03.ja.md)(SC-01) / [PERMISSION_GRANT_UNIFICATION_PLAN](./PERMISSION_GRANT_UNIFICATION_PLAN_2026-10-19.ja.md)(PG) / [COHERENCE_AUDIT_PLAN](./COHERENCE_AUDIT_PLAN_2026-10-01.ja.md) / [ENTITY_GOVERNANCE_UNIFICATION_PLAN](../improvement-plans-2026-08/ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)
>
> **起票日**: 2026-10-21 / **状態**: partial（レビュー修正・共通基盤と段階移行を実装）

---

## 0. 結論

「本来は概念として切り出すべきなのに、各所へ直接実装されているもの」は存在する。性質は 2 種類に分かれる。

| 種別                 | 内容                                         | 分布 | 扱い                                             |
| -------------------- | -------------------------------------------- | ---- | ------------------------------------------------ |
| **A. helper bypass** | 正準の抽象は既にあるが、呼び出し側が使わない | 大半 | SX の adopt-or-delete で解消(本計画では追わない) |
| **B. 概念欠落**      | 抽象そのものが無く、各所が独自実装している   | 一部 | **本計画の対象(CX-01〜07)**                      |

B に該当するのは次の 5 つ。いずれも SX / SC / PG のどこにも「正本を 1 つにする」施策として立っていない。

1. **合成された Actor 文脈**(identity + authority + actor が別系統)
2. **ロック付き JSON レコードストア**(バイト書込は正準、レコード更新は無法地帯)
3. **Runtime state の論理パス registry**(登録 6 件に対し literal を埋め込む 147 ファイル)
4. **Rate limiter / Failure tracker**(正準が存在しない)
5. **Check / レポート harness**(83 本が 4 形式で出力)

加えて、**語彙の正本**(`MissionStatus` / `KnowledgeTier` / `PipelineStep`)と、**再増加を止めるゲート**(CX-08)を置く。CX-08 は他施策の前提であり、最初に実施する。

---

## 1. 調査方法

**基準リビジョン: `origin/main` @ `d9591fdd3`(2026-10-21 取得)**。`libs/` `scripts/` `presence/` `satellites/` を対象に、テストと `dist/` を除外して grep で計測した。件数は AST ではなくパターン一致による**指標値**であり、テスト用シームなど正当な重複も含む。再測定は §9 のコマンドで行う。

> **再検証メモ(2026-10-21)**: 初回調査は作業ツリー(未コミット変更 130 ファイルを含む)に対して行ったため、`dist` 配下の `.d.ts` を含む計測が混ざっていた。本版は `origin/main` のクリーンな export に対して全数を取り直した値である。比較の結果、次の 3 点が判明した。
>
> - 型名の重複は **46 個ではなく 4 個**だった(初回は `libs/core/dist/*.d.ts` を二重計上)
> - runtime state の literal は「348 種」ではなく **147 ファイル**で計るべき(文字列の種類は定数定義・テスト用フィクスチャで水増しされる)
> - `origin/main` では registry が 4 → 6 件に増えていたが、`PipelineStep` / `MissionStatus` / `KnowledgeTier` の重複と、正準モジュール不在(`ActorContext` / `JsonStateStore` / `defineCheck` / rate limiter はいずれも 0 件)は変わっていない

---

## 2. 観測結果

### 2.1 概念 × 正準 × 分散

| #   | 概念                               | 正準の置き場                                   | 分散の実測                                                                                                                                                                                                       | 種別                           |
| --- | ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | Actor / Scope context              | `scope-context.ts`, `authority.ts`, `actor.ts` | 相互補完でない **6 つの型**、env 直読み(tenant 79 / persona 89 / MISSION_ROLE 58 / MISSION_ID 94 ファイル)、`normalizeTenant*` **14**、`normalizeMissionId*` **7**、tenant slug 正規表現 **21 箇所/15 ファイル** | **B**                          |
| 2   | JSON レコードストア                | `secure-io`, `foundation/json`, `lock-utils`   | `safeWriteFile` + 自前 `JSON.stringify` **368 ファイル**(同一行のみ 330)、`writeJson` 呼び出し 50、ロック無し RMW **約 70 ファイル**、ロック実装の複製 **2 系統**、`writeJson` ローカル再実装 **7**              | **B**                          |
| 3   | Runtime state の論理パス           | `foundation/runtime-state-roots.ts`            | 登録 **6 件** に対し literal を埋め込む **147 ファイル**。同一パスの 3 重定義あり                                                                                                                                | **B**                          |
| 4   | Retry / Poll / RateLimit / Breaker | `pipeline/retry-utils.ts`, `async-utils.ts`    | 手書き retry **17**、`sleep` の定義・別名 **11**、rate limiter **10 実装**、failure tracker **約 13 実装**、poll/wait の手書きも各所                                                                             | **B**(rate/breaker は正準なし) |
| 5   | CLI コマンド契約                   | `script-harness.ts`, `cli-guard.ts`            | yargs 経由 **79**、`flags: []` の defineScript **198**、`Usage:` 直書き **215**、`argv.indexOf` 直書き **43 ファイル**                                                                                           | A + B                          |
| 6   | Check / レポート harness           | (なし)                                         | `check_*` **83 本**、`ScriptExitError(1, …)` **368**、CheckResult 型 **6 定義**、失敗出力 **4 形式**、`--json` 対応 3 本、`--fail` 依存 1 本                                                                     | **B**                          |
| 7   | Approval / Consent / Grant         | `governance/approval-store.ts` ほか            | 承認ドラフト手組み **9 箇所**、consent 検査の重複                                                                                                                                                                | A(PG が追跡中)                 |
| 8   | Actuator pipeline step 形状        | `defineActuator`(SX-10 で計画)                 | `PipelineStep` の **12 定義**                                                                                                                                                                                    | A(計画済)                      |
| 9   | ドメイン語彙                       | `mission-status.ts`, `types.ts`                | 3 箇所以上に同名定義される export 型 **4 個**(`PipelineStep` 12 / `KnowledgeTier` 3 / `GateResult` 3 / `ComputerInteractionAction` 3)。別に `MissionStatus` 2、tier rank map 6                                   | **B**                          |
| 10  | Pipeline 起動                      | `run_pipeline`(ライブラリ入口が未整備)         | 呼び出し形 **5 種**                                                                                                                                                                                              | A(SX-10/11)                    |

### 2.2 概念が壊れている兆候(代表例)

**① Actor / Scope — 6 つの半身**

| 型                   | 場所                                                    | 欠けているもの                     |
| -------------------- | ------------------------------------------------------- | ---------------------------------- |
| `ScopeContext`       | `libs/core/scope-context-validation.ts:4`               | role, persona, sudo, actor         |
| `IdentityContext`    | `libs/core/types.ts:257`                                | org, project, task, session, actor |
| `ResolvedPrincipal`  | `libs/core/authn-principal-resolver.ts:96`              | mission, task, session             |
| `ExecutionScope`     | `libs/core/foundation/execution-scope.ts:39`            | ほぼ全部                           |
| `OwnerScope`         | `libs/core/owner-scope.ts:44`                           | role, persona, mission             |
| `SurfaceViewerScope` | `libs/core/surface/surface-viewer-scope-contract.ts:13` | 実行主体                           |

どれも全体を持たないため、呼び出し側が必要な項目だけ env から拾う。

- `libs/core/tier-guard.ts:959-962` — `assumedRole || SYSTEM_ROLE || MISSION_ROLE` で `authority.resolveRole` を再実装
- `libs/core/spend-guard.ts:96` — `tenantId ?? getRegisteredEnvText('KYBERION_TENANT')`
- `libs/core/metrics.ts:770` — `input.mission_id || getRegisteredEnvText('MISSION_ID')`
- `libs/core/organization/tenant-governance.ts:144` — `agentId: input.actor || KYBERION_PERSONA || 'operator'`

文法も分岐している。`owner-scope.ts:116` だけ `'default'` を許容、`spend-guard.ts:207` は validate せず lowercase のみ、mission id は 5 種の正規表現、sudo は `'1'` と `'true'` の 2 流儀(`history-search-index.ts:736`)。

**② JSON 永続化 — バイトは正準、レコードは無法地帯**

- 原子的書込は `libs/core/secure-io.ts:476` に一本化済み(良い)
- しかし `safeWriteFile` + 自前 `JSON.stringify` が 368 ファイル。`foundation/json.ts` の `writeJson` は 50 呼び出し
- ロック無し RMW が約 70 ファイル(例: `organization/tenant-activation.ts:504`、`workforce/work-inventory.ts:685`)
- ロック実装の丸ごと複製: `deliverable-inbox.ts:114-190` と `organization/tenant-rate-limiter.ts:192-240`(`sleepSync` + `isStaleLock` + jitter まで同一)
- `writeJson` ローカル再実装 7 件(`co-session.ts:243`, `surface/surface-artifact-store.ts:25` ほか)

正しい形は `provider-pins-store.ts:118-137` と `ledger.ts:139` が手で示している。

**③ Rate limit / Failure tracking — 正準が無い**

- 固定ウィンドウ rate limiter が presence 3 + core 3 + concierge 1。戻り値は `retryAfterSeconds` / `retry_after_ms` / boolean とバラバラ。`express-rate-limit` を使う第 3 系統もある
- Circuit breaker に相当するものは 13 実装。閾値 1/2/3/なし、リセット never/TTL/per-tick、動作 throw/disable/demote/sleep が揃っていない
- retry は actuator では `withRetry` に収束(約 100 箇所)しているが、core runtime では手書きが残る。遅延カーブは線形 / 指数 capped / 指数 uncapped / 固定 / 遅延なしの 5 種

**④ 語彙 — 同名型の多重定義**

- `MissionStatus` 2 定義(`mission-status.ts:8` / `mission-context-pack-types.ts:13`)。現在は同一だが、以後の分岐リスク
- `KnowledgeTier` 3 定義(`types.ts:18` / `contracts/wisdom-action.ts:169` / `wisdom-actuator/knowledge-package.ts:13`)
- `PipelineStep` 12 定義(core 2 + actuator 10)
- 3 箇所以上に同名定義される export 型は **4 個**。うち `PipelineStep` が 12 定義と突出している
- tier の順序リストは `scope-envelope.ts:74` を正準に 6 つの rank map が並立し、`context-security-scope.ts:5-9` は重み付けが異なる(1/3/4)

**⑤ Check / CLI — 層が併存し、script がランダムに選ぶ**

- yargs 経由 79 / `guardCliArgs` 17 / 手書きパーサ 45 / `argv.indexOf` 直書き 43
- `defineScript` の 198 件が `flags: []` で argv を自前再パース。`Usage:` 直書き 215
- 入口定型 `if (isDirectScript(...))` を **374 ファイル**が持つ
- `check_*` 83 本で失敗出力 4 形式、`--json` 3 本、`--fail` を付けた時だけ落ちるもの 1 本(`check_deprecated_wisdom_ops.ts:84`)
- `scripts/project_controller.ts:35-70` は `hasFlag` / `validateOptions`(= `guardCliArgs` の再実装)/ `requiredOption` / `csvOption` / `jsonOutput` を自前で持つ

---

## 3. 設計原則

1. **新規抽象は 1 領域 1 個**。似た helper を増やさない。既存の `guardCliArgs` / `withLockSync` / `async-utils` / `ActorRef` の上に作る。
2. **Adopt-or-delete を同一 PR で**。新 helper を追加したら、旧経路を codemod で置換し、lint 禁止と件数ラチェットまで入れる。両方残すことを禁止する(SX 原則 1 の踏襲)。
3. **ラチェットで再増加を止める**。各施策は「削る数」を受入基準に持ち、`check_type_ratchet` と同じ方式で上限を CI に焼き込む。
4. **境界で 1 回だけ mint する**。文脈は dispatch 境界で発行し、内側では再導出しない。env は境界と foundation/env のみ。
5. **状態と出力を区別する**。`JSON.stringify` の禁止対象は永続状態の書込であり、API レスポンスや成果物の整形は対象外。

---

## 4. 施策

### CX-01: 合成 ActorContext の導入(P0 / L / 依存: SC-01)

**症状**: §2.2①。`ScopeEnvelope`(SC-01)は identity 半分のみで、authority(role/persona/sudo)と actor は別系統のまま。そのため各所が env を読み、正規化を再実装する。

**実装**:

- `ActorContext = { actor: ActorRef; scope: ScopeContext; authority: { role; persona; authorities; sudo } }` を定義する。**新型を増やさず**、`ScopeContext` を内包する合成ビューにする(identity の正本は SC-01 のまま)
- `resolveActorContext()` を dispatch 境界に置き、`currentActor()`(AsyncLocalStorage)で内側へ配る。env からの補完は境界でのみ行い、`provenance: 'env' | 'claim' | 'explicit'` を残す
- `normalizeTenant*` 14 → `normalizeTenantSlug()` 1、`normalizeMissionId*` 7 → `normalizeMissionId()` 1、tenant slug 正規表現 21 → `TENANT_SLUG_PATTERN` 1 に統合。`'default'` と `'1'/'true'` の扱いは移行表で明示する
- 置換対象(実測): `tier-guard.ts:959`、`spend-guard.ts:96,207`、`metrics.ts:770`、`tenant-governance.ts:144`、`network.ts:145`、`seam-provider-selection.ts:179`、`task-scoped-grants.ts:355`、`surface_runtime.ts:192`

**受入基準**:

- `libs/core` の runtime コードで、文脈系 env の直読みが **0**(境界・`foundation/env`・allowlist のみ)
- `normalizeTenant*` **14 → 1**、`normalizeMissionId*` **7 → 1**、tenant slug regex **21 → 1**
- sudo の解釈が 1 つ、mission id の文法が 1 つ
- `check:actor-context-adoption` ラチェットを追加

---

### CX-02: ロック付き JSON レコードストア(`JsonStateStore`)(P0 / M)

**症状**: §2.2②。原子書込はあるが「読む→変更する→書く」を 1 トランザクションにする抽象が無い。

**実装**:

- `openJsonState<T>({ path | logicalPath, schema?, lock?: { scope; timeoutMs }, default })` を `libs/core/foundation` に置く
- API は `read()` / `update(fn)` / `replace(value)` / `append(record)`。`update` は `withLockSync` + read + fn + atomic write を 1 単位にする
- ロック無しの書込 API を公開しない。内部で `safeWriteFile` を使うが、利用側からは直接触れない
- `deliverable-inbox.ts:114-190` と `tenant-rate-limiter.ts:192-240` のロック実装を削除し、本ストア or `withLockSync` へ寄せる
- schema 検証は**新規ストアのみ必須**。既存は移行時に段階導入する

**受入基準**:

- 変換対象モジュールのロック無し RMW が **0**
- ロック実装の複製 **2 → 0**、`writeJson` ローカル再実装 **7 → 0**
- `check:json-state-write-discipline`: 永続状態パス配下の `safeWriteFile(JSON.stringify` 件数を上限固定し、増加を fail

---

### CX-03: Runtime state 論理パス registry(P1 / S)

**症状**: §2.1 #3。`PARTITIONED_RUNTIME_STATE_ROOTS` は 6 件のみで、147 ファイルが literal を埋め込む。同一パスの重複定義:

- `active/shared/runtime/dot-wake-ledger.jsonl` — `dot/dot-runtime.ts:105`, `dot/dot-followups.ts:44`, `dot/dot-inbox.ts:297`
- `active/shared/runtime/dot-lifecycle-audit.jsonl` — `dot/dot-lifecycle.ts:48`, `dot/dot-charter.ts:362`
- `memory/promotion-queue.jsonl` — `knowledge/memory-promotion-queue.ts:124` と `knowledge/pr-knowledge-readiness.ts:192`(後者はコメントで「tenant layout を mirror している」と自認)

**実装**:

- registry を全 runtime state に拡張し、`runtimeStatePath('dot.wakeLedger', scope?)` が**論理パスと物理パス(tenant 分割含む)の両方**を返す
- 既存 literal を codemod。tenant 分割のレイアウトは registry 側に 1 回だけ書く
- 新規 literal を禁止する lint(`check:runtime-path-literal`)を追加。allowlist は registry 実装とテストのみ

**受入基準**:

- `libs/core` が使う runtime state の **100% が registry 経由**
- 重複定義 **3 系統 → 0**、literal を埋め込む **147 ファイル → 0**(registry 経由)
- `process.cwd()` フォールバック 2 件(`chain-integrity.ts:63`, `python-voice-bridge.ts:129`)を削除

---

### CX-04: Rate limiter と Failure tracker の正準化(P1 / M)

**症状**: §2.2③。10 の rate limiter と 13 の failure tracker が、閾値・窓・戻り値・リセット規則をバラバラに持つ。

**実装**:

- `fixedWindowLimiter({ key, limit, windowMs, maxKeys, eviction })` を `libs/core/rate-limit.ts` に置く。戻り値は判別可能な型 `{ allowed: true } | { allowed: false; retryAfterMs: number }` に統一
- durable 版は CX-02 の上に実装(`tenant-rate-limiter` の永続状態を移行)
- `FailureTracker({ threshold, reset: 'never' | 'ttl' | 'tick', action: 'throw' | 'open' | 'demote' | 'disable' })` を置き、provider 健康性・feedback loop・schedule の失敗計数を寄せる
- 閾値と窓はコードでなく governance JSON に宣言する
- presence の `express-rate-limit` は adapter で本実装に寄せるか、残す理由を各 surface の設定に明記する(429 のレスポンス形式が異なるため)

**受入基準**:

- 固定ウィンドウ実装 **10 → 1 機構**(adapter 含む)
- failure tracking **13 → 1 抽象** + 宣言的閾値
- `retryAfterSeconds` / `retry_after_ms` の混在が 0

---

### CX-05: Check harness(`defineCheck`)(P1 / M / 依存: SX-07)

**症状**: §2.2⑤。83 本の `check_*` が、Findings 型・終了コード・`--json` 形状・成功表記をそれぞれ決めている。

**実装**:

- `defineCheck({ id, collect(ctx): Finding[], render(findings) })` を `libs/core/check-harness.ts` に置く
- 契約を固定する: findings > 0 なら exit 1、`--json` は `{ ok, id, findings: [{ code, message, path?, line? }] }`、成功は `[check:<id>] OK`
- `ci-gates.json`(SX-07)の `id` と 1:1 対応させ、manifest に無い check は CI で走らないことを明示する
- `--fail` 依存(`check_deprecated_wisdom_ops.ts:84`)を廃止し、常に findings で判定する

**受入基準**:

- `check_*` 83 本が harness 経由 or 削除
- 失敗出力 **4 形式 → 1**、CheckResult 型 **6 → 1**、`ScriptExitError(1, …)` の直書き **368 → 0**(harness 内のみ)
- 全 check が `--json` を返す

---

### CX-06: CLI コマンド契約(`defineCommand`)(P1 / M / SX-05・SX-06 に統合)

**症状**: §2.2⑤。パーサが 4 系統あり、`defineScript` の 198 件が `flags: []` で自前再パースする。

> **注意**: 第 5 のパーサ層を作らない。`guardCliArgs` + `parseScriptFlags` を土台にし、SX-05 の command registry に合流させる。

**実装**:

- `defineCommand({ name, positionals, options: [{ flag, value, required }], manifestId })` が parser + help + unknown-flag error + `--json` 出力を生成する
- help は `cli-commands.json` から描画し、`Usage:` 文字列を手書きしない
- `context.print` を唯一の直列化点にし、`print(JSON.stringify(...))` を禁止する

**受入基準**:

- 独自パーサ **45 → 0**(harness 外)、`argv.indexOf` 直書き **43 → 0**、`--help` 手判定 **0**
- `Usage:` 直書き **215 → 0**(catalog 由来のみ)
- `flags: []` の defineScript **198 → 0**

---

### CX-07: 語彙の正本化(P2 / S / 依存: SX-12)

**症状**: §2.2④。3 箇所以上に同名定義される export 型が 4 個あり(`PipelineStep` は 12 定義)、tier の重み付けも 2 種ある。

**実装**:

- `MissionStatus` / `KnowledgeTier` / `TierOrder` / `PipelineStep` を 1 箇所(`contracts` もしくは `foundation/vocabulary.ts`)に置き、actuator はそこから import する
- 状態遷移表(`mission-status.ts:18`)を唯一の遷移正本とし、`mission-context-pack-types.ts` の再宣言を削除
- tier の順序・重みは `scope-envelope.ts` の 1 定義に寄せ、`context-security-scope.ts:5-9` の重み付けを明示的に統合する

**受入基準**:

- `MissionStatus` **2 → 1**、`KnowledgeTier` **3 → 1**、`PipelineStep` **12 → 1**
- 3 箇所以上に同名定義される export 型 **4 → 2**(`GateResult` / `ComputerInteractionAction` は用途が異なるため統合対象外。新規追加は fail)
- tier rank map **6 → 1**

---

### CX-08: ゲート修復とラチェット(P0 / S / 他施策の前提)

**症状**: 再増加を止める仕組みが無い、または穴がある。

- `libs/core/security-boundary.contract.test.ts` は `.ts` しか走査せず、**`.mjs` 9 ファイルが構造的に素通り**
- allowlist 13 件のうち 8 件が stale(import が無い、またはパスが存在しない `libs/core/src/lock-utils.ts`)。再検証で host profile manager 2 件は有効な例外と確認した
- `JSON.stringify` / `sleep` / env 直読み / runtime literal に対するラチェットが無い(`check_test_sleep_ratchet` はテストのみ)

**実装**:

- 境界テストの走査対象に `.mjs` / `.js` を追加し、stale allowlist を削除する
- 本計画の各指標に対するラチェットを `ci-gates.json` に登録する:
  - `env_direct_read_budget`(文脈系 env)
  - `json_state_write_budget`
  - `runtime_path_literal_budget`
  - `rate_limiter_impl_budget`
  - `exported_type_name_duplication_budget`
  - `bespoke_cli_parser_budget`
- いずれも `paths` を持たせ、変更パスに応じて `pnpm check -- --changed` で走るようにする

**受入基準**:

- `.mjs` の raw fs import が検出される(stale allowlist 0)
- 6 つのラチェットが CI で走り、baseline を超えたら fail
- `pnpm check -- --scope full` と CI のゲート集合が一致する

---

## 5. Wave と依存

| Wave  | 施策                       | 理由                                     |
| ----- | -------------------------- | ---------------------------------------- |
| **0** | CX-08                      | ゲートが無いと、以降の削減が再増加する   |
| **1** | CX-01(SC-01 完了後)、CX-02 | 文脈と状態が他の全ての土台               |
| **2** | CX-05、CX-06、CX-03        | CX-02 の上に check / CLI / path を載せる |
| **3** | CX-04、CX-07               | 状態と語彙が固まってから                 |

Wave 内は並列可。Wave 間は前 Wave のラチェットが green であることをゲートにする。

---

## 6. 指標と目標

| 指標                                       | 現状(origin/main @ d9591fdd3) | Wave 1 後             | 完了時            |
| ------------------------------------------ | ----------------------------- | --------------------- | ----------------- |
| 文脈系 env に触れるファイル(4 変数ののべ)  | 320 ファイル                  | 主要 8 モジュールで 0 | 0(allowlist のみ) |
| `normalizeTenant*` / `normalizeMissionId*` | 14 / 7                        | 1 / 1                 | 1 / 1             |
| tenant slug 正規表現の複製                 | 21 箇所 / 15 ファイル         | 1                     | 1                 |
| ロック無し RMW                             | 約 70 ファイル                | 主要ストアで 0        | 0                 |
| runtime path literal                       | 147 ファイル                  | registry 化 50%       | 100%              |
| rate limiter / failure tracker             | 10 / 約 13                    | —                     | 1 / 1             |
| check の出力形式                           | 4                             | 2                     | 1                 |
| 同名 export 型(3 箇所以上)                 | 4                             | 4                     | 2                 |

---

## 7. 非目標

- **既に正しく共有されているものは触らない**: schema 読込・検証(`validate`, `schema-loader`)、`mission_controller` ルーティング、`pathResolver`、`renderScriptError`
- **新しい DI コンテナやフレームワークを入れない**。既存の AsyncLocalStorage / `withLockSync` / `guardCliArgs` の上に作る
- **テスト用シームを潰さない**。注入可能な `sleep` や `options.sleep` はテスト設計として明示されているものは対象外
- **payload の `JSON.stringify` を禁止しない**。対象は永続状態の書込のみ
- **actuator の `PipelineStep` を一括で消さない**。SX-10 の `defineActuator` に合わせて段階移行する

---

## 8. リスクと未決

| リスク                                                        | 対応                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| grep ラチェットの誤検知(payload と state の区別)              | パス配下 + 関数境界で限定し、allowlist を registry とテストのみに絞る   |
| AsyncLocalStorage が届かない境界(CLI 直叩き、presence server) | 境界で明示的に mint し、`provenance` を記録。届かない場合は fail-closed |
| `express-rate-limit` の置換で 429 形式が変わる                | adapter で吸収し、surface ごとのレスポンス契約テストを先に書く          |
| 一括 codemod の事故                                           | 領域ごとに PR を分割し、ラチェットで再増加を止める                      |
| `'default'` tenant など legacy 値の扱い                       | 移行表を作り、CX-01 の PR で読み替えを 1 箇所に閉じ込める               |

**未決事項**:

1. CX-01 を SC-01 の `ScopeEnvelope` に統合するか、合成ビューとして別に置くか(推奨: identity は `ScopeContext` のまま、authority を `policy` 層に足し、`ActorContext` は合成ビュー)
2. CX-02 の schema 検証を既存ストアにも必須にするか(推奨: 新規のみ必須、既存は移行時)
3. `express-rate-limit` を残すか、完全に自前へ寄せるか(surface ごとの 429 契約次第)

---

## 9. 再測定コマンド

作業ツリーには他プロバイダーの未コミット変更が混ざるため、必ず `origin/main` のクリーンな export に対して計測する。

```bash
# 0. クリーンな origin/main を取り出す
git fetch origin
TMP=$(mktemp -d)
git archive origin/main | tar -x -C "$TMP"
cd "$TMP"

# 1. 文脈系 env に触れるファイル数(4 変数ののべ)
for v in KYBERION_TENANT KYBERION_PERSONA MISSION_ROLE MISSION_ID; do
  echo "$v: $(grep -rl "$v" libs scripts presence --include='*.ts' \
    | grep -v '\.test\.' | grep -v '/dist/' | wc -l)"
done

# 2. 正規化関数と tenant slug 正規表現の複製
grep -rnE "(export )?function normalizeTenant[A-Za-z]*" libs scripts --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/'
grep -rnE "(export )?function normalizeMissionId[A-Za-z]*" libs scripts --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/'
grep -rn "\[a-z\]\[a-z0-9-\]{1,30}" libs scripts presence --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/'

# 3. JSON 永続化
grep -rl "safeWriteFile" libs scripts --include='*.ts' | grep -v '\.test\.' | grep -v '/dist/' \
  | xargs grep -l "JSON.stringify" | wc -l
grep -rn "writeJson(" libs scripts --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/' | grep -v 'function writeJson' | wc -l
grep -rl "lock-utils" libs scripts --include='*.ts' | grep -v '\.test\.' | grep -v '/dist/' | wc -l

# 4. runtime state(literal の「種類」は定数定義で水増しされるのでファイル数で計る)
grep -rl "active/shared/runtime/" libs scripts --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/' | wc -l
grep -cE '^  [a-z_]+:' libs/core/foundation/runtime-state-roots.ts

# 5. 語彙(dist を find で除外してから数える)
find libs -name '*.ts' -not -path '*/dist/*' -not -name '*.test.ts' -print0 \
  | xargs -0 grep -hoE '^export (interface|type) [A-Z][A-Za-z0-9_]+' \
  | awk '{print $3}' | sort | uniq -c | awk '$1>=3' | sort -rn

# 6. CLI / check
grep -rn "flags: \[\]" scripts --include='*.ts' | grep -v '\.test\.' | wc -l
grep -rn "Usage:" scripts --include='*.ts' | grep -v '\.test\.' | wc -l
ls scripts/check_*.ts | grep -v '\.test\.' | wc -l
grep -rn "ScriptExitError(1" libs scripts --include='*.ts' | grep -v '\.test\.' | wc -l

# 7. sleep / retry
grep -rnE '(export )?(async )?function sleep\b|const sleep =|function sleepSync' \
  libs scripts satellites presence --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/' | wc -l
grep -rnE 'for \(let attempt' libs scripts --include='*.ts' \
  | grep -v '\.test\.' | grep -v '/dist/' | wc -l
```

> **注意**: `grep -h` を使うとパスが消えるため、`grep -v '/dist/'` で除外できなくなる(初回調査で型名が 46 個に膨らんだ原因)。`dist` の除外は `find` か `-l`/`-r`(パスを残す)で行う。

## 10. 実装レビューと今回の到達範囲（2026-10-21）

実装基準を `origin/main@5ce8aabc3` へ更新した。§1〜9 の件数は元調査のスナップショットであり、現在の完了宣言ではない。リスク表に従い領域単位で移行する。今回の PR は共通基盤・実利用・再増加ゲートを導入する最初の変更である。

### レビューで修正した設計

- **CX-01**: ActorContext は検証済み scope と actor の帰属を保持し、authority は既存 resolver から参照時に再解決する。呼出側の role/sudo を受け付けず、claim/explicit は認証証拠と扱わない。異なる正常化文法を一律に統合しない。
- **CX-02**: JSONL inbox を JSON 配列へ変更しない。新 JsonStateStore は schema 必須・同期 update・破損時 fail-closed。tenant quota の専用 mutex は read-only sandbox の厳密な I/O 例外が前提のため保留し、ポリシーを広げて件数を達成しない。
- **CX-03**: Dot の global 配置を勝手に tenant 配置へ変更しない。registry はキーごとの既存配置と scope 条件を保持する。
- **CX-04**: tenant-rate-limiter は重み付き token bucket であり fixed-window ではない。アルゴリズムを保持する。HTTP Retry-After の秒単位や既存 wire field は adapter に残し、内部の decision を統一する。cooldown と固定窓も区別する。
- **CX-05/06**: 第5の parser を作らず、既存 CLI guard を core へ移して defineScript と合成する。check は findings のみで失敗し --fail は不要になる。全83 check の出力契約変更は後続の段階移行とする。
- **CX-07**: schema 生成の discriminated union や intent step を広い PipelineStep に置き換えない。正本化は共通の語彙・順位から行い、異なる操作契約は維持する。TIERS は重み1/3/4から順位0/1/2へ統一し、数値を点数として扱う契約にはしない。
- **CX-08**: 既存 allowlist の host profile manager2件は raw fs を実際に使うため削除対象ではない。bootstrap の mjs は secure-io 読込前の境界として理由付きで明示し、各例外が存在して raw import を持つことも検証する。

### 受入条件の実装状況

| 施策  | 今回実装                                                                                                | 残る移行                                                               |
| ----- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CX-01 | 非認可用 ActorContext、claim holder dispatch、監査への適用、並行隔離・再検証テスト                      | 全 env/normalizer の削除。文法と認証境界を個別確認する                 |
| CX-02 | schema-backed JsonStateStore、provider pins 全 mutation、inbox の正準 mutex、ローカル serializer の除去 | 他ストア RMW、tenant quota mutex の限定 sandbox 対応                   |
| CX-03 | Dot wake/lifecycle・memory queue・quota の registry と重複定義除去、cwd fallback2件除去                 | 全 runtime state の登録。147→0 の完了とはしない                        |
| CX-04 | 固定窓と失敗追跡の共通機構、実 consumer、governance policy                                              | 固有の token bucket/transport adapter と残る失敗追跡を個別移行         |
| CX-05 | defineCheck、CLI manifest と deprecated Wisdom check の移行                                             | 残りの check 出力・exit 契約                                           |
| CX-06 | 既存 guard の core 正本化と defineCommand、既存 guard 利用者への適用                                    | 独自 parser/help/flags の段階移行                                      |
| CX-07 | MissionStatus2→1、knowledge tier の型・順位と比較利用箇所の統一                                         | 生成 schema 型、意味が異なる PipelineStep12件は generator-aware に整理 |
| CX-08 | TS/JS/MJS の raw fs AST 検出、stale 例外検査、6つの path-based CI ratchet                               | source indicator で削減を続ける。基盤導入だけでゼロ達成とはしない      |

### 安全な更新手順

Inbox と provider pins の mutex は正準 protocol へ変更される。旧プロセスと新プロセスは異なる lock identity を持つため、旧 writer を停止してから更新・再起動する。稼働中に新旧を混在させない。JSON/JSONL の保存形式・配置は維持される。弱い旧 lock を過去互換性だけのために残さない。

6つの ratchet は AST による source indicator のファイル別上限であり、全ての RMW race や意味的重複を検出する証明ではない。基準は変更前の clean checkout から作成し、今回の削減後は下げる。生成ファイル・テスト・ビルド出力は source 指標から除外する。既存機能を損なう統合と未移行箇所はこの表で区別する。
