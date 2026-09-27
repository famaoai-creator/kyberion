---
title: SEAM DISPATCH UNIFICATION PLAN 2026 09 28
tags: [improvement-plan, 2026-09, refactoring, seam, dispatch]
last_updated: 2026-09-28
status: draft
---

# if 連鎖の seam / adapter / facade 移行計画(DS-01〜DS-09)

> 優先度: P1〜P2 / 規模: L(段階実装) / 親計画: [SIMPLICITY_ABSTRACTION_PLAN](../improvement-plans-2026-08/SIMPLICITY_ABSTRACTION_PLAN_2026-08-25.ja.md)(SX-05, SX-10, SX-12) / 関連: [REGISTRY_SPLIT_PLAN](../REGISTRY_SPLIT_PLAN.md), [module-layer-boundaries.json](../../../knowledge/product/governance/module-layer-boundaries.json)
> **起票日**: 2026-09-28
> **状態**: DRAFT(alignment 済み・未着手)
> **監査対象**: `libs/core`(トップレベル非テスト 1,150 ファイル + テスト 1,038)、`scripts/`、`libs/actuators/*`、`presence/`、`satellites/`

---

## 0. 結論(先に)

if 連鎖の監査対象は大きく 3 種に分かれ、**対処法も 3 種に収斂する**:

1. **provider / kind / action のディスパッチ**(本計画の主対象) → `createSeam<T>({ multiplicity: 'named' })` または既存の route-handler 配列パターン(`SURFACE_RUNTIME_ROUTE_HANDLERS`)へ移す。seam 機構は既に 40 拡張点で稼働しており、新規機構は **不要**。
2. **CLI / フラグ引数のディスパッチ** → SX-05 の command registry と `defineScript` ハーネス側の宣言的フラグ仕様へ寄せる(既存計画の未移行分)。
3. **リテラル集合の membership 判定** → seam ではなく `Set` / alias テーブルへの素朴な置換で足りる。

根本原因は SX 計画の **R1(正しい抽象があるのに採用されない)** と同じで、seam / factories マップが存在するのに、手書きの `switch`/`if` 連鎖が並走している点にある。したがって本計画も **adopt-or-delete**(移行と旧経路の削除・lint 抑止を同一 PR で行う)と **ラチェットによる再発防止** の 2 原則を継承する。

---

## 1. 監査サマリ

| #   | 箇所                                                                                          | 症状                                                                                                                            | 移行先                                                 | 親SX  |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- |
| A1  | `libs/core/reasoning-cli-provider.ts`                                                         | `switch (mode)` 8 case、各 case が backend+intentExtractor+voiceBridge を同形組立                                               | named seam `cli-provider-bundle`(provider 自己登録)    | SX-12 |
| A1' | `provider-backend-resolver.ts` / `agent-adapter.ts`                                           | provider→実装マップが 3 系統並走(`DEFAULT_CONSTRUCTORS` / `AGENT_ADAPTER_FACTORIES` / 上記 switch)                              | A1 の seam に一本化                                    | SX-12 |
| A2  | `libs/core/organization-operating-model.ts`                                                   | `input.kind ===` ×26、load/save/relation/label で同じ 4 分岐を反復                                                              | `Record<Kind, EntityKindHandler>` or named seam        | SX-12 |
| A3  | `presence/displays/chronos-mirror-v2/src/app/api/intelligence/route.ts`                       | `action ===` ×16、各ブロック大(412-1282 行)                                                                                     | route-handler 配列(SURFACE_RUNTIME_ROUTE_HANDLERS 式)  | SX-12 |
| A4  | `scripts/check_governance_rules.ts`                                                           | `check.id ===` ×31、検査ロジックが 1 関数に集積                                                                                 | `Record<CheckId, CheckHandler>` レジストリ             | SX-12 |
| A5  | `satellites/voice-hub/server.ts`                                                              | `adapter.adapter_id ===` ×13 が 2 ブロックで重複                                                                                | STT adapter capability 記述子(voice-provider-adapters) | SX-09 |
| A6  | `libs/actuators/media-actuator/src/artisan/extraction-engine.ts`                              | `mode ===` ×33 が各 extractor に散在                                                                                            | extractor の `supportedModes` 宣言 + 枠組み側 filter   | SX-10 |
| A7  | `libs/core/narrated-video-brief-compiler.ts` / `video-content-brief-contract.ts`              | `semantic ===` 同一グルーピング ×48 が複数関数にコピペ                                                                          | `SEMANTIC_TRAITS` 特性テーブル(contract 層)            | SX-12 |
| A8  | `streaming-tts-bridge.ts` / `provider-capability-registry.ts` / `agent-pane-runtime-herdr.ts` | seam があるのに `id === 'gemini'` `providerId === 'claude'` `kind === 'claude'` が漏出                                          | provider metadata / capability flag へ                 | SX-12 |
| A9  | `scripts/cli.ts` ほか CLI 群                                                                  | `command ===` ×34(cli.ts)、`parsed.command ===` ×50、`arg ===` ×85(args パーサ)                                                 | SX-05 command registry / 宣言的フラグ仕様              | SX-05 |
| B5  | `libs/actuators/*/src/*-pipeline-helpers.ts`                                                  | 7+ アクチュエータで足場を複製(browser 1588 / modeling 1217 / wisdom 962 / code 707 / file 556 / network 372 行)                 | actuator-sdk / pipeline-host へ共通スケルトン引上げ    | SX-10 |
| B1  | `libs/core/` トップレベル                                                                     | `{provider}-{capability}.ts` 約 40 ファイルの行列が平置き                                                                       | A1 の seam 化後に `providers/` 等へ git mv(SX-12 窓)   | SX-12 |
| B2  | `libs/core/` 全体                                                                             | 平置き 1,150 ファイル、prefix クラスタ(mission 96 / surface 34 / agent 34 / voice 30 / reasoning 25 / intent 23…)が既に自然境界 | SX-12 のディレクトリ再編(本計画では境界案のみ提示)     | SX-12 |
| B3  | `libs/core/src/`                                                                              | トップレベルと並立する二重構造(engine 系だけ src/)                                                                              | B2 と同時に畳み込み(SX-02 メモ「移動自体は SX-12」)    | SX-12 |
| B4  | `libs/core/index-part-01..11.ts`                                                              | 3,927 行の生成バレルが番号分割のみ                                                                                              | B2 のドメイン別バレルに再生成(SX-12 barrel ≤300 目標)  | SX-12 |

**移行対象外(seam にしないもの)**:

- `deliverable-quality.ts` / `voice-stt.ts`: リテラル列挙 → `Set` / alias map(数行の修正)
- `shell-command-normalize.ts`(`executable ===` 連鎖): ポリシースキャンのパーサ内部。テーブル化は可能だがセキュリティ経路のため別扱い
- `mission-triage.ts`(`status ===`): 状態アドバイザリのドメインロジック。map 化は任意

---

## 2. 計画一覧

| ID    | 内容                                                                     | 親SX     | 規模 | 依存         |
| ----- | ------------------------------------------------------------------------ | -------- | ---- | ------------ |
| DS-01 | provider bundle seam 統合(A1+A1'):`cli-provider-bundle` named seam 新設  | SX-12    | M    | —            |
| DS-02 | entity-kind handler レジストリ(A2)                                       | SX-12    | S    | —            |
| DS-03 | Chronos intelligence route の action handler 化(A3)                      | SX-12    | M    | —            |
| DS-04 | governance check handler レジストリ(A4)                                  | SX-12    | M    | —            |
| DS-05 | voice-hub adapter_id capability 記述子化(A5)                             | SX-09    | S    | —            |
| DS-06 | semantic 特性テーブル化(A7)+ media extraction の supportedModes 宣言(A6) | SX-12/10 | S    | —            |
| DS-07 | seam 漏出の provider 特別扱い解消(A8)                                    | SX-12    | S    | DS-01        |
| DS-08 | CLI ディスパッチの command registry 移行(A9)                             | SX-05    | L    | SX-05 残課題 |
| DS-09 | actuator pipeline-helpers 共通スケルトン(B5)                             | SX-10    | L    | SX-10 残課題 |

B1〜B4(ディレクトリ再編・バレル再編)は SX-12 の git mv 窓で実施する項目であり、本計画では §4 の分割案を提示するに留める(ロジック変更と混ぜない原則)。

---

## 3. 各計画

### DS-01: provider bundle の named seam 統合(P1 / M)

**症状**: `reasoning-cli-provider.ts` の `switch (mode)` が 8 case で各プロバイダの bundle(backend + intentExtractor + voiceBridge)を手書き組立。一方 `provider-backend-resolver.ts` の `DEFAULT_CONSTRUCTORS` と `agent-adapter.ts:1391` の `AGENT_ADAPTER_FACTORIES` が同じ provider→実装対応を別マップで保持しており、**provider 追加時に 3 箇所を同期する必要がある**。

**実装**:

1. `createSeam<CliProviderBundleFactory>({ key: 'cli-provider-bundle', multiplicity: 'named', catalog: coreSeamCatalog })` を新設。
2. 各 provider ファイル(`claude-cli-*` / `codex-cli-*` / …)が `bundleFactory` を自己登録する形に変更。`buildCliProviderBundle` は `seam.get(mode).build(options)` に縮退。
3. `DEFAULT_CONSTRUCTORS` / `AGENT_ADAPTER_FACTORIES` は同一 seam から導出する互換レイヤに置き換え(adopt-or-delete。公開 API は維持しつつ実体は seam を引く)。
4. `KYBERION_REASONING_BACKEND` の mode 解決順序(policy → discovery → fallback)は `reasoning-backend-policy.json` 側の現行挙動を変えない。

**受入基準**: provider→実装マップの記述箇所が **3 → 1**。`switch (mode)` 撤去。provider 追加が 1 ファイルの自己登録で完結することを新規 provider の追加テストで検証。`reasoning-backend-policy.test.ts` 系の既存テスト全パス。

### DS-02: organization-operating-model の kind handler 化(P1 / S)

**症状**: `input.kind === 'domain'|'capability'|'service'|'operation'` の 4 分岐が load(684-687)/ save(719-723)/ relation/label(756-804)で 3 回以上反復。

**実装**: `Record<OrgEntityKind, { load, save, relations, describe }>` を 1 箇所に定義し、各分岐を `handler = KIND_HANDLERS[input.kind]` に置換。kind 追加はハンドラ登録のみで完結させる。

**受入基準**: `input.kind ===` の出現が **26 → ≤4**(ハンドラ定義内のみ)。

### DS-03: Chronos intelligence route の handler 配列化(P1 / M)

**症状**: `action ===` ×16 が 1 つの route.ts に直書き(最大ブロック数百行)。SX-12 で「Chronos intelligence route の責務分割」は済んだが dispatch は残留。

**実装**: `surface-runtime-orchestrator.ts` の `SURFACE_RUNTIME_ROUTE_HANDLERS` と同型の `{ match(action), handle(req, ctx) }[]` を導入。route.ts は一覧 + 委譲のみにし、各 handler を `route-handlers/` 配下のファイルに分割。handler は server-side の `ViewerContext` 境界を越えない(CHRONOS_VIEWER_SCOPE_OPERATIONS の不変条件)。

**受入基準**: route.ts ≤300 行、`action ===` 0。各 action の既存挙動を contract テストで固定してから移行。

### DS-04: governance check の handler レジストリ(P1 / M)

**症状**: `check_governance_rules.ts` が `check.id ===` ×31 の if 連鎖(ファイル 203 if)。check 追加のたびに同一関数へ追記。

**実装**: `Record<CheckId, (check, ctx) => Promise<Finding[]>>` レジストリに分割し、check ごとにファイルを切る(`scripts/checks/*.ts` が自己登録、または静的 import 一覧)。catalog(`cli-commands.json` 等)側の check 列挙と handler の有無を CI で突き合わせる。

**受入基準**: `check.id ===` 0。check 定義と handler の乖離が lint/check で検出可能。

### DS-05: voice-hub adapter_id の記述子化(P1 / S)

**症状**: `adapter.adapter_id ===` が 531-554 / 599-615 の 2 ブロックでほぼ同じ一覧を判定(launchable / needsRuntime 等の属性を if で分岐)。

**実装**: adapter 記述子(`voice-provider-adapters.ts` 側)に capability フラグ(`kind: 'server'|'native'|'cli'|'python-bridge'` 等)を持たせ、分岐を属性参照に置換。2 ブロックの重複判定も 1 関数へ。

**受入基準**: `adapter.adapter_id ===` 0(記述子定義内を除く)。

### DS-06: 特性テーブル 2 件(P2 / S)

- **`SEMANTIC_TRAITS`**: `semantic === 'process'|'steps'|'demo'` 等の同一グルーピング ×48 を `video-content-brief-contract.ts` 側(domain 層)の特性テーブルに集約。compiler / contract / 他 consumer は `TRAITS[semantic].isProcessLike` 等を参照。
- **media extraction の `supportedModes`**: extraction-engine の `mode ===` ×33 を、各 extractor が対応 mode を宣言する形に変更し、フィルタを呼び出し側(media-backend-registry の枠組み)へ移す。

**受入基準**: 対象ファイルの `semantic ===` / `mode ===` が特性参照に置換。分類変更がテーブル 1 行の修正で済むこと。

### DS-07: seam 漏出の特別扱い解消(P2 / S、DS-01 後)

- `streaming-tts-bridge.ts:168` `if (id === 'gemini')` ファクトリ特別扱い → provider metadata(`factory` / capability flag)
- 同 228 行 `record.id === 'stub' || 'gemini'` スキップ → provider 記述子の `probeable: false` 等
- `provider-capability-registry.ts:362,386` `providerId === 'claude'` 認証特別扱い → capability の `auth_check` フィールド
- `agent-pane-runtime-herdr.ts:621` `kind === 'claude'` の `--model` 引数 → `resolveAgentLaunchArgs` 側の per-kind 戦略へ

**受入基準**: seam 登録外のコードに provider literal 特別扱いが残らない(grep で 0)。

### DS-08: CLI ディスパッチの command registry 移行(P1 / L、SX-05 継続)

**症状**: SX-05 で command registry は導入済みだが、`cli.ts` に `command ===` ×34 が残留(未移行分)。`organization_operating_model.ts` は `parsed.command ===` ×50、`*_args.ts` は `arg === '--xxx'` ×85 の手書きフラグパーサ。

**実装**: SX-05 の registry へ残コマンドを移し、`organization_operating_model_args.ts` は宣言的フラグ仕様(`{ name, alias, takesValue, target }[]`)に置換。`pipeline-execution-part-*.ts` の `action ===`/`op ===` も同パターンで整理。

**受入基準**: `cli.ts` の `command ===` 0(register 呼び出しのみ)。フラグ仕様テーブルから `--help` とパースを生成。

### DS-09: actuator pipeline-helpers 共通スケルトン(P1 / L、SX-10 継続)

**症状**: SX-10 で `defineCatalogBackedActuator` への移行は済んだが、「domain-specific internal helper 7 件(code/modeling/wisdom/android/orchestrator/browser/ios)」が残課題と明示されている。`*-pipeline-helpers.ts` が import 群・retry ポリシ・manifest 解決・trace・preflight を複製(計 4,400 行超)。

**実装**: 共通スケルトンを `libs/core/actuator-sdk`(全 actuator が既に import)配下の `pipeline-host` として引き上げ、各 helper は manifest path + domain ops の宣言だけを残す。SX-10 の方針(ABI 統一、`run_pipeline` ライブラリ入口)に従う。

**受入基準**: `*-pipeline-helpers.ts` の重複 import/retry/trace ブロックが除去され、各ファイルが domain 差分のみを持つ。helper 総行数をラチェットで固定。

---

## 4. `libs/core` ドメイン分割案(B1〜B4、SX-12 git mv 窓で実施)

ロジック変更と分離するため、本節は分割案の提示のみ。SX-02 の方向 ratchet が green(現状 0 violations)なので移動自体は可能。prefix クラスタから自然な境界:

| 候補ディレクトリ | 収容 prefix                                                          | 規模 |
| ---------------- | -------------------------------------------------------------------- | ---- |
| `mission/`       | `mission-*`                                                          | 96   |
| `surface/`       | `surface-*`                                                          | 34   |
| `agent/`         | `agent-*`(runtime/dispatch/pane/adapter 系)                          | 34   |
| `voice/`         | `voice-*` + `audio-*` + `*-tts-*` + `*-stt-*` + `vad-*`              | ~40  |
| `reasoning/`     | `reasoning-*` + provider 行列(`claude-*`/`codex-*`/`gemini-*` 等)    | ~65  |
| `intent/`        | `intent-*`                                                           | 23   |
| `media/`         | `video-*` + `media-*` + `*-pptx/docx/pdf` engine 系(src/ からも)     | ~50  |
| `knowledge/`     | `knowledge-*`                                                        | 16   |
| `entity/`        | `tenant-*` + `organization-*` + `project-*` + `scope-*` + `entity-*` | ~30  |

`src/` はこの再編で畳み込み(B3)。バレルは part 番号でなくドメイン別に再生成し、SX-12 の `index.ts ≤300 行` 目標に接続(B4)。`module-layer-boundaries.json` の patterns も「ファイル列挙」から「ディレクトリ → layer」に書き換え、`default_layer` 垂れ流しを解消する。

---

## 5. KPI / ラチェット

| 指標                                               | 現状       | 目標           | 対象  |
| -------------------------------------------------- | ---------- | -------------- | ----- |
| provider→実装マップ記述箇所                        | 3          | 1              | DS-01 |
| `reasoning-cli-provider.ts` の switch              | 1(8case)   | 0              | DS-01 |
| `organization-operating-model.ts` `input.kind ===` | 26         | ≤4             | DS-02 |
| intelligence route.ts `action ===` / 行数          | 16 / ~1300 | 0 / ≤300       | DS-03 |
| `check_governance_rules.ts` `check.id ===`         | 31         | 0              | DS-04 |
| `semantic ===` / `mode ===`(extraction)            | 48 / 33    | 0*             | DS-06 |
| seam 外の provider literal 特別扱い                | 4 箇所     | 0              | DS-07 |
| `cli.ts` `command ===`                             | 34         | 0              | DS-08 |
| `*-pipeline-helpers.ts` 総行数                     | ~4,400     | ラチェット上限 | DS-09 |

*特性テーブル・記述子定義内を除く。

削減数は `check_type_ratchet` と同方式で CI に焼き込み、再増加を止める。

---

## 6. リスク

- **登録順序**: named seam への自己登録は import 副作用に依存する。provider が未 import で「未登録」になるリスク → bootstrap が provider 一覧を明示 import する形に留め、lazy import は DS-01 のスコープ外とする。
- **挙動の固定順序**: DS-03/DS-04 は dispatch の順序・優先度が現行 if 連鎖の書記順に依存し得る → 移行前に現行挙動を contract テストで固定。
- **SX 計画との同時編集**: DS-08/DS-09 は SX-05/SX-10 の残課題そのもの。SX 計画側の実装状況節を正本として進捗を同期し、衝突時は SX 側を優先。
- **`shell-command-normalize.ts` は触らない**: ポリシースキャンの入力経路であり、de-obfuscation の挙動変更はセキュリティ影響が大きい。

## 7. 実行形状

work-scope-policy 上、`cross_system_mutation` + `artifact_estimate_5plus` + `expected_continuation_beyond_session` の蓄積トリガー ≥2 で **mission 形状**。各 DS 項目は 1 mission(または DS-06/DS-07 のような小項目の束)として `mission_controller` 経由で開始し、direct work の場合は `record-evidence` でタスクを閉じる。git mv を伴う B1〜B4 は他計画の PR が閉じた窓で実施(SX 計画 §6 の原則を継承)。
