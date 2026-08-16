---
title: pi 分析・採択計画(PI-01〜19)
tags:
  [
    pi,
    agent-harness,
    session,
    compaction,
    usage-accounting,
    telemetry,
    extension-model,
    trust,
    model-runtime,
    supply-chain,
    adoption-plan,
  ]
last_updated: 2026-08-16
status: planned
---

# pi 分析・採択計画(PI-01〜19)

> **作成日**: 2026-08-16
> **分析対象**: [earendil-works/pi](https://github.com/earendil-works/pi)(旧 badlogic/pi-mono)v0.84.2 @ `086c32e74`(2026-08-15、5,685 commits。clone: `active/shared/tmp/pi`、分析後に削除可)
> **位置づけ**: QM / CLAW_EMPIRE / CLOUDFLARE_OS / TAKT 採択計画と同型の「外部システム分析 → kyberion への選択的取り込み」計画。対象は **エージェント harness の耐久実行モデル・セッション/圧縮・使用量会計・テレメトリ契約・拡張/信頼モデル・モデルランタイム・供給網/リリース工学** の 7 領域。
> **前提**: pi を依存として取り込まない。pi の TUI・CBOR プロトコル・単一ユーザ前提(`~/.pi/`、権限システム非搭載)は持ち込まない。pi の実装ではなく **型契約と不変条件** を kyberion の既存基盤(`mission_controller` / `agent-runtime-supervisor` / `worker-context-compaction` / `spend-guard` / `Trace` / plugin gate / `ReasoningBackend`)に接続する。

## 1. pi とは何か(要約)

pi は Node/Bun/Deno/ブラウザで動く「最小コア + 攻撃的に拡張可能」なコーディングエージェント(MIT)。10 パッケージ(`ai` / `agent` / `coding-agent` / `tui` / `protocol` / `client` / `server` / `session-backends/sqlite-node` / `telemetry` / `evals`)。設計哲学は明文化されている: 「**No MCP. No sub-agents. No permission popups (run in a container). No plan mode. No built-in to-dos. No background bash.**」(`packages/coding-agent/README.md:490-505`)、「**pi's core is minimal**. If your feature does not belong in the core, it should be an extension」(`CONTRIBUTING.md:7-13`)、「Sessions are stored as trees」。

直近 3 か月(v0.72→v0.84.2、~858 changelog 項目)の投資配分: プロバイダ幅と正確性 45% / TUI 21% / 拡張・SDK・RPC・クライアントプロトコル 17% / セッション・圧縮・harness 16% / 認証 16% / **非同期正確性・キャンセル・ロック競合 11%(急増)** / 供給網・検証可能リリース 4%。v0.84.0 で **lane ベースの harness v4**(耐久 operation record、`SessionRepo`、共有 seq、tree-scoped lane view)へ書き換え中で、`packages/agent/src/harness/agent-harness.ts` は「compile-complete scaffold」(全 operation が `HarnessNotImplemented`)。**そのため型・record log・reducer・telemetry schema が実装に汚されない「仕様」として読める**のが今回の最大の収穫。

### kyberion との構造対比

| 軸               | pi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | kyberion(現状、`origin/main` 実コード突合)                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 耐久実行の単位   | **operation**(`run \| compaction \| navigation`、同一 lifecycle・同一 outcome `completed\|declined\|aborted\|failed(\|suspended)`)。**entries(会話木)と records(orchestrator の意図ログ)を分離**、recovery は records だけを読む。`ProvisionedEntry`(id+内容を先に mint→意図を記録→書く、復元時 deep-equal 検証)。12 種の corruption 理由で復元を**拒否**(修復しない)                                                                                                                                              | `mission-orchestration-journal.ts` は `enqueued\|completed\|failed` の 3 状態、replay plan あり。`mission_controller` checkpoint/resume は状態ファイル直読み。exactly-once の意図記録・corruption 分類なし                                                                                                                              |
| 並行性の単位     | lane(共有 session tree への cursor + 開いている operation 高々 1)。`LaneBusy{lane, operationId, operationKind}`                                                                                                                                                                                                                                                                                                                                                                                                    | mission / task / worker プロセス(`agent-runtime-supervisor`)。EV で `acquireLock` 非ブロッキング欠陥を修正済み。fencing token なし                                                                                                                                                                                                      |
| 駆動             | `drive: automatic \| manual`、`peekAction()/executeAction()`(次に取る `ActionInfo` を覗ける steppable state machine)                                                                                                                                                                                                                                                                                                                                                                                               | pipeline dry-run(`pipeline-dry-run.ts`)はあるが worker 実行は非 steppable。TK-03 `core:await_decision` は pipeline 層                                                                                                                                                                                                                   |
| 入力キュー       | `steer`(実行中に注入)/ `followUp`(次 turn)/ **`nextRun`(operation を跨いで生存、`runId` を持たない唯一のキュー)**、`cancelQueued` は `cancelled\|already_consumed\|already_cleared`                                                                                                                                                                                                                                                                                                                                | SO-03 steering(実行中注入)あり。worker 再起動を跨ぐ耐久キューなし                                                                                                                                                                                                                                                                       |
| 圧縮             | トリガ `contextTokens > window − reserve`。**hybrid 推定**(最後の provider usage を錨に、以降のみ char/4)。cut point は toolResult を跨がない。分割 turn は 2 要約(0.8×/0.5×)。**要約は「更新」**(前要約を渡し PRESERVE / In Progress→Done 移動)、file 操作は累積。`retainedTail` を entry に埋め込む自己完結 checkpoint。要約リクエストは routing 隔離(`cacheRetention:"none"`, 新 sessionId)。`compactionReason: manual\|threshold\|overflow` を記録し overflow 再帰を guard                                     | `worker-context-compaction.ts`: microcompact + LLM summary、**char/4 のみ**(`estimateTokens :167`)、要約は都度生成、3 連続失敗で無効化。KS で scope/egress 対応済み                                                                                                                                                                     |
| 使用量会計       | `UsageRecord{cause: assistant\|tool\|hook\|compaction\|branch_summary\|deferred_fetch\|adjustment}` を record log に。**入力量段階制 pricing tier**(`ModelCostTier.inputTokensAbove` が request 全体に適用)、`cacheRead/cacheWrite/cacheWrite1h` 分離、footer に cache-hit 率 `CH`、`showCacheMissNotices`                                                                                                                                                                                                         | `model-cost-registry.json` は **prompt/completion 2 値・段階制なし・cache 区分なし**、`spend-guard.ts` に cause 属性なし(要約・judge・subagent の spend は主呼び出しに混ざるか消える)                                                                                                                                                   |
| テレメトリ       | `packages/telemetry`: 22 行の callback interface(span は callback に閉じる)+ **直列化可能 schema**(`parents` 制約、`cardinality: low\|high`、`sensitive`、閉じた `values`、`status.errorWhen`)、`ExactTelemetryAttributes` で余剰属性を**コンパイルエラー**、schema から docs 生成                                                                                                                                                                                                                                 | `Trace` stable v1(`libs/core/src/trace.ts` 355 行、`TraceEvent/Artifact/Span`)+ replay。属性の cardinality/sensitive/親制約は無く、docs は手書き。TK-10 で OTel span 予定                                                                                                                                                               |
| クライアント同期 | 「**snapshot が正、progress event は UI ヒント**」を README と `client/src/state.ts` で強制(revision 単調、古い snapshot 破棄)。session lease `shared\|exclusive`(失敗時の semantics を明記)。**wire-safe error 5 種 vs `InternalServerError`(cause を絶対に直列化しない)**                                                                                                                                                                                                                                        | Chronos は SSE 単一購読(CE-02)+ REST。error の直列化境界は route ごと。MCP/peer も同様                                                                                                                                                                                                                                                  |
| 拡張モデル       | lifecycle graph を 1 枚の契約として公開(`project_trust → session_start → resources_discover → input → before_agent_start → … tool_call(block/terminate、input を in-place 修復可)→ tool_result(部分 patch middleware)→ … agent_end → agent_settled`)。sibling tool は **preflight 直列・実行並列**。`agent_settled`(retry/圧縮/follow-up 全て済)≠ `agent_end`                                                                                                                                                      | `EXTENSION_POINTS.md` + plugin gate + `enforceApprovalGate`(block のみ、repair なし)。順序図なし。settled 相当なし                                                                                                                                                                                                                      |
| 信頼             | trust を要する resource 集合を定数で列挙(`settings.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md`)、**pre-trust load set = context files + global extensions のみ**、決定は最近接祖先 + `defaultProjectTrust ask\|always\|never`、`project_trust` event で拡張が決定を委譲可、非対話は ignore。guard 例は **`if (!ctx.hasUI) return {block:true}`**(人不在は拒否)。全 resource に `PathMetadata{source, scope, origin, baseDir}` provenance。package filter は `!/+/-` で **narrow only** | plugin provenance gate(KD-06)、`restricted-skills.json`(**消費者 0**)、tenant→org→project chain(scope 契約は KS/KO で整備)。resource 単位の provenance 型・narrow-only filter・pre-trust 順序の明文化なし                                                                                                                               |
| スキル/資源      | Agent Skills 標準、**progressive disclosure**(prompt には name+description の XML のみ、本文は `read` ツールで)、`disable-model-invocation` / `allowed-tools` frontmatter、`AGENTS.override.md` per-directory 置換 + worktree shadow 抑止、prompt template `${1:-default}`                                                                                                                                                                                                                                         | skill-wrapper / facet registry(TK-04)/ `mission-context-pack` slices / `AGENTS.md`+symlink。skill 本文は pack に同梱                                                                                                                                                                                                                    |
| モデルランタイム | `ModelRuntime`(catalog + provider-owned `/login` + header 組立を 1 か所で)、ETag 再検証 catalog(304 で `checkedAt` のみ更新、失敗は stale-but-usable)、**generation-checked `publish()`**、`thinkingLevelMap` 三値(省略/文字列/`null`=非対応)、constrained sampling `prefer\|require`、**deferred tool loading(additive 変更で cache prefix 維持)**、`retry.provider.maxRetries=0` 推奨(SDK が quota error を握り潰すのを防ぐ)、`pi auth check` 資格情報 preflight、`AI_AGENT=pi` 子プロセス標識                   | `ReasoningBackend`(20 mode、failover chain、`backend-capability-profile.ts` は boolean 能力)、`reasoning-backend-policy.json`(`allowed_modes`, `tenant_overrides`)、`backend-conformance.ts`(binary/version probe のみ)、`model-registry.json`。model catalog 更新機構・graded 能力・credential preflight・provider 層 retry の明示なし |
| 供給網/リリース  | exact pin + `min-release-age=2` + lockfile commit gate(`PI_ALLOW_LOCKFILE_CHANGE`)+ **lifecycle-script allowlist(`pkg@version → 理由文`、消えた entry もエラー)** + shrinkwrap/install-lock、決定的 source archive + `SHA256SUMS`、`release:local`(repo 外へ pack→install)、changelog 監査 commit、`APPROVED_CONTRIBUTORS` を commit で付与(`lgtm`/`lgtmi`)                                                                                                                                                        | `validate` に 40+ `check:*`、`KYBWEION_PRODUCT_RELEASE_GOVERNANCE`。lockfile gate・min-release-age・script allowlist・再現可能アーカイブ・repo 外 install smoke なし                                                                                                                                                                    |
| 評価             | `packages/evals`: **harness = 名前付きエージェント構成**、`evalHarnessTable` で同一入力を構成違いで A/B、multi-step 入力(`prompt → reload → prompt`)、`.eval/runs.jsonl`                                                                                                                                                                                                                                                                                                                                           | `eval/facets/*.json`(TK-11 系)、`eval:distill`。構成 A/B の table 化・reload を跨ぐ eval なし                                                                                                                                                                                                                                           |

**採択の基本判断**: kyberion は mission / tenant / governance という pi より広い領域を持つ一方、**「1 つの worker 実行をどう耐久・再開・会計・観測するか」という harness の芯**は pi の方が精緻に型定義されている。取り込むのは (1) 耐久実行の型契約(record log / reducer / ProvisionedEntry / corruption 拒否)、(2) 圧縮と会計の精度(hybrid 推定・更新型要約・cause 属性・pricing tier・cache 区分)、(3) 観測と同期の不変条件(schema 化 telemetry・snapshot 正・error 直列化境界)、(4) 拡張/信頼/資源の「列挙された契約」(lifecycle 順序・preflight repair・trust set・provenance・narrow-only)、(5) モデルランタイムの運用可能性(graded 能力・catalog 更新・auth preflight・retry 分離・deferred tools)、(6) 供給網ゲート。pi の TUI・CBOR・単一ユーザ trust store・「権限は container に任せる」思想は持ち込まない。

## 2. 改善項目一覧

| ID    | タイトル                                                                                                                                | 優先度 | 規模 | 対応する既存計画 / 基盤                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | ------------------------------------------------------------------------- |
| PI-01 | 使用量会計の cause 属性・段階制 pricing・cache 区分                                                                                     | **P0** | M    | `spend-guard.ts` / `metrics.ts` / `model-cost-registry.json` / CO-03      |
| PI-02 | wire-safe error 境界(内部 cause を直列化しない)                                                                                         | **P0** | S    | MCP server engine / Chronos API / peer messaging / KS-13                  |
| PI-03 | trust を要する resource 集合の列挙と `restricted-skills.json` の消費者実装                                                              | **P0** | S    | KD-06 plugin gate / KS-14 / KO                                            |
| PI-04 | worker 圧縮の hybrid token 推定・更新型要約・自己完結 checkpoint                                                                        | P1     | M    | `worker-context-compaction.ts` / KC-06 / KS-11                            |
| PI-05 | mission 耐久実行の record log + pure reducer + ProvisionedEntry + corruption 拒否                                                       | P1     | L    | `mission-orchestration-journal` / `mission_controller` resume / EG        |
| PI-06 | Trace の直列化可能 schema(親制約・cardinality・sensitive・Exact 型・docs 生成)                                                          | P1     | M    | `libs/core/src/trace.ts` / TK-10 / OP-01                                  |
| PI-07 | 「snapshot が正・event は hint」の Chronos 同期契約と revision 単調                                                                     | P1     | M    | CE-02 SSE / `surface-coordination-store`                                  |
| PI-08 | 拡張 lifecycle 順序図の公開と tool preflight `{block, reason, terminate, repaired_input}` + `settled` イベント                          | P1     | M    | `EXTENSION_POINTS.md` / `enforceApprovalGate` / plugin gate               |
| PI-09 | resource provenance 型と narrow-only filter(`!`/`+`/`-`)、skill の progressive disclosure と `disable-model-invocation`/`allowed-tools` | P1     | M    | skill-wrapper / facet registry(TK-04)/ `mission-context-pack`             |
| PI-10 | model runtime: graded 能力(`thinkingLevelMap` 三値)・constrained sampling `prefer\|require`・per-model `compat` override                | P1     | M    | `backend-capability-profile.ts` / `reasoning-backend-policy.json` / RG-01 |
| PI-11 | `pnpm auth check`(backend 別 credential preflight)と provider 層 retry の明示分離                                                       | P1     | S    | `backend-conformance.ts` / `reasoning-backend.ts` failover / run:doctor   |
| PI-12 | 供給網ゲート: min-release-age・lockfile commit gate・lifecycle-script allowlist(理由文付き)・repo 外 install smoke                      | P1     | S    | `validate` / release governance                                           |
| PI-13 | backend conformance を「実行可能仕様」へ(全 mode が通す executable spec を package export)                                              | P1     | M    | `backend-conformance.ts` / QM-06                                          |
| PI-14 | worker 実行の manual drive(`peekAction/executeAction`)と approval gate の「次アクション検査」接続                                       | P2     | M    | TK-03 / `agent-runtime-supervisor` / `approval-store`                     |
| PI-15 | steer / followUp / **nextRun** の 3 キューと worker 再起動を跨ぐ耐久 nextRun                                                            | P2     | M    | SO-03 steering / worker dispatch                                          |
| PI-16 | fencing token 付き writer lease(単一 SQL)で mission 状態の単一 writer 保証                                                              | P2     | S    | `agent-runtime-supervisor` / EV `acquireLock` / history sqlite            |
| PI-17 | deferred tool loading(additive 変更で prompt cache 維持)と role 別 tool 露出                                                            | P2     | M    | MCP catalog / skill-wrapper / KP-01                                       |
| PI-18 | eval harness table(構成 A/B)と reload を跨ぐ multi-step eval                                                                            | P2     | S    | `eval/facets` / TK-11 / QM-03                                             |
| PI-19 | 並走セッションの git 禁止動詞リストを guardrail へ(prose→enforce)                                                                       | P2     | S    | `adf-guardrails.ts` / co-execution contract / SA-02                       |

---

### PI-01: 使用量会計の cause 属性・段階制 pricing・cache 区分(P0 / M)

**pi の設計**: `UsageRecord` は `cause ∈ {assistant, tool, hook, compaction, branch_summary, deferred_fetch, adjustment}` で属性付けされ record log に残る(`packages/agent/src/harness/session/types.ts:190`)。`ModelCost.tiers[{inputTokensAbove, input, output, cacheRead, cacheWrite}]` は「最も高い一致閾値を request 全体に適用」(`packages/ai/src/types.ts:784-790`)、`cacheWrite1h` を分離。`getUsageCostBreakdown()` は provider/model 別 + `Tools/summaries` バケット(`usage-totals.ts:35-60`)。

**kyberion の現状**: `model-cost-registry.json` は `{prompt, completion}` per 1k のみ(段階制 0 件、cache 区分なし)。`spend-guard.ts` に cause 属性なし。要約(compaction)・judge・subagent・repair の LLM 呼び出しは主呼び出しに混ざるか記録されない。200K 超の長文脈で単価が倍になるモデルは**過少計上**。

**実装**: (1) `model-cost-registry.json` schema に `tiers[]` と `cache_read/cache_write/cache_write_1h` を追加(既存 2 値は互換)、`resolveCostRates()` が request 全体 input で tier 選択。(2) `spend-guard`/`metrics` の記録に `cause` と `{mission_id, task_id, tool_call_id?}` を必須化、`adjustment` の手動補正 API。(3) cost-report と Chronos cost route に cause 別内訳と cache-hit 率(`CH`)。(4) 大幅な cache miss は dispatch observability に notice。受入: 要約・judge・subagent の spend が主呼び出しと別 cause で集計され、tier 境界を跨ぐ fixture で従来比の差額がテストで固定される。

### PI-02: wire-safe error 境界(P0 / S)

**pi の設計**: `PiServerError` は wire を渡る 5 code(`busy|session_locked|not_found|invalid_request|not_implemented`)のみ、`InternalServerError` は「cause を報告用に保持するが**絶対に直列化しない**」(`packages/server/src/errors.ts`)。client 側は transport down と lease 解放を別型で区別。

**kyberion の現状**: MCP server engine / Chronos API route / peer messaging の error 直列化は route ごと(`error.message` をそのまま返す箇所あり)。tenant 名・path・stack が別 tenant の viewer に漏れうる。

**実装**: `libs/core/wire-error.ts` に `WireSafeError{code, message(固定文言), correlation_id}` と `toWireError(err)`(未知 error は `internal` + correlation_id、cause は audit/log にのみ)を置き、MCP engine・Chronos `api/**`・peer server の catch を全て通す。`check:wire-error-boundary`(route の catch で `err.message` を返していない)を CI に。受入: 内部 error の message/stack/path が response body に含まれない fixture、correlation_id で audit から追跡できる。

### PI-03: trust resource 集合の列挙と `restricted-skills.json` 消費者(P0 / S)

**pi の設計**: `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` を定数で列挙し(`trust-manager.ts:28-35`)、pre-trust load set(context files + global extensions のみ)を明文化。決定は最近接祖先 + `defaultProjectTrust ask|always|never`、`project_trust` event で拡張が決定を委譲、非対話では prompt せず ignore。guard は `if (!ctx.hasUI) return {block:true}`(人不在は拒否)。

**kyberion の現状**: plugin gate(KD-06)は install 時 provenance。実行時に「project/tenant ローカル resource のどれが承認を要するか」の列挙がなく、`restricted-skills.json` は **TS 消費者 0**(KS 監査)。承認 gate の非対話時挙動は gate ごと。

**実装**: (1) `libs/core/trust-requiring-resources.ts` に kyberion 版集合(`.kyberion-plugins.json`, project/tenant `pipelines/`, `roles/PROCEDURE.md` overlay, facet overlay, `AGENTS.override.md`, skill dirs)を定数化し、loader は pre-trust set 以外を trust 解決後にのみ読む。(2) `restricted-skills.json` を `skill-plugin-loader`/`skill-wrapper` が消費(tenant_overrides と合成、narrow only)。(3) 承認 gate 共通の `hasHuman()` を導入し、非対話 mission では**拒否**(silent allow を禁止)。受入: restricted skill が worker から呼べない、非対話で human 承認が必要な op が拒否され receipt に理由が残る。

### PI-04: worker 圧縮の hybrid 推定・更新型要約・自己完結 checkpoint(P1 / M)

**pi の設計**: `estimateContextTokens` は最後の provider usage を錨にし以降のみ char/4、`{tokens, usageTokens, trailingTokens}` で測定/推定を可視化(`compaction.ts:216`)。cut point は toolResult を跨がない。要約は `UPDATE_SUMMARIZATION_PROMPT` で前要約を渡し「PRESERVE / In Progress→Done」、`details.{readFiles, modifiedFiles}` を累積。`retainedTail` を entry に埋め込み 1 entry から文脈復元。要約リクエストは `cacheRetention:"none"` + 新 sessionId で routing 隔離。`compactionReason` を記録し overflow 再帰を guard。

**kyberion の現状**: `worker-context-compaction.ts` は char/4 のみ(`:167`)、要約は都度生成(前要約非参照)、summary artifact は別ファイル。KS-11 で scope 区画化と egress gate は済。

**実装**: (1) `estimateContextTokens` を backend の直近 usage(あれば)を錨にする hybrid へ、測定/推定比を trace 属性に。(2) 前要約を入力に取る更新型 prompt(prompt は knowledge store に置く: PI-06 の非採用 6 参照)と `readFiles/modifiedFiles` の累積。(3) compaction 記録に `reason: manual|threshold|overflow` と `retained_tail` を含め、`retained_tail` から単独で文脈再構築できることをテスト。受入: 5 回連続圧縮で初回に決めた事項が要約に残る golden、overflow 再帰が 1 回で止まる。

### PI-05: mission 耐久実行の record log + reducer + ProvisionedEntry(P1 / L)

**pi の設計**: entries(会話)と records(`operation_started|abort_requested|operation_finished|step_attempt|tool_started|queue_enqueued|queue_cancelled|write_deferred|usage`)を分離。`reduceLaneState(input) → {laneState, effectiveConfiguration, terminalFailure}` は I/O なし・有界 slice(`findOpenOperations(limit:2)`)。`ProvisionedEntry`(id+内容を先に mint→意図記録→書く、復元で deep-equal 不一致は `provisioned_entry_mismatch`)。12 種 corruption は復元を**拒否**。

**kyberion の現状**: `mission-orchestration-journal` は 3 状態、`mission_controller` resume は状態ファイルとタスク contract を読み直す。worker 出力の「着地したか」は再走査で判断。

**実装**: 段階導入。(a) journal entry に `operation{id, kind: run|compaction|handoff|checkpoint, attempt}` と `outcome` を追加、(b) `reduceMissionState(records)` を pure 関数として切り出し resume が使う(既存経路と結果一致テスト)、(c) worker 成果物の書き込みを `provision → record → write → verify` にし、不一致は `MISSION_LOG_CORRUPT:{reason}` で resume 拒否(手動 reconcile-work 経路へ)。受入: 途中 kill → resume で二重実行/欠落なし、corruption fixture で拒否+理由コード。

### PI-06: Trace の直列化可能 schema(P1 / M)

**pi の設計**: `TelemetrySpanDefinition{description, parents, startAttributes(required), endAttributes, events, status{default, errorWhen}}`、属性は `type/description/sensitive?/cardinality/values`。`ExactTelemetryAttributes` で余剰属性はコンパイルエラー。`scripts/generate-telemetry-docs.ts` が schema から docs 生成。span は callback に閉じる。

**kyberion の現状**: `Trace` v1 は型はあるが属性の cardinality/sensitive/親制約なし、docs 手書き。TK-10 で OTel span 化予定 — その前に schema を持つべき。

**実装**: `libs/core/trace-schema.ts` に span 定義(mission/task/step/tool/compaction/judge/hook/gate)、`sensitive` 属性は redaction に、`cardinality:high` は metric から除外、`parents` は replay validator が検証。`generate:trace-docs` で `docs/developer/TRACE_SCHEMA.md` を生成し `check:reference-drift` に載せる。TK-10 の OTLP export は本 schema から派生。

### PI-07: Chronos 同期契約「snapshot が正・event は hint」(P1 / M)

**pi の設計**: 「Session and server snapshots are authoritative. Progress events are transient UI hints and must not be reduced into authoritative state」(`packages/protocol/README.md`)、`applyServerSnapshot` は `revision < current` を破棄。再接続 = snapshot 取得、replay なし。session lease `shared|exclusive` と失敗 semantics(`detach` 失敗は lease 復元、`dispose` 失敗は次回取得前に reconcile)。

**kyberion の現状**: Chronos は SSE 単一購読(CE-02)+ REST。SSE event を state に畳み込む component があり、順序/欠落で表示がずれる。「observer 多数・coordinator 1」の lease 概念は UI 側にない。

**実装**: 各 panel の store を `{snapshot, revision}` + `event → refetch hint` に統一、SSE payload に `revision` を載せ、古い snapshot を破棄。live intervention(SU-02)には `exclusive` lease(coordinator)/ `shared`(observer)を API に。受入: event の順序入替・欠落 fixture で最終表示が snapshot と一致。

### PI-08: 拡張 lifecycle 順序図と tool preflight repair・settled(P1 / M)

**pi の設計**: 1 枚の順序図(`docs/extensions.md:275-348`)。`tool_call` は `event.input` を in-place 修復可・`{block, reason, terminate}`、sibling は **preflight 直列・実行並列**。`tool_result` は部分 patch middleware。`agent_settled`(retry/圧縮/follow-up が全部済んでから)。`before_agent_start` は `systemPromptOptions`(sensitive 扱い)を典型入力で公開。

**kyberion の現状**: `EXTENSION_POINTS.md` は一覧だが順序図なし。`enforceApprovalGate` は block のみ(scope 注入・path 固定などの「修復」不可)。task 完了 event は retry/圧縮前に発火しうる。

**実装**: (1) `EXTENSION_POINTS.md` に mission/task/tool の順序図を正本として追加し `check:extension-order`(hook 登録が図の名前だけを使う)。(2) tool preflight を `{decision: allow|block, reason, repaired_input?, terminate?}` に拡張、preflight は直列・実行は並列を規約化、修復は audit に差分。(3) `task_settled` を新設し governance receipt はこれに反応。受入: scope 欠落 tool call を preflight が修復して通す fixture、`task_completed` の後に retry が起きても settled は 1 回。

### PI-09: resource provenance・narrow-only filter・skill progressive disclosure(P1 / M)

**pi の設計**: 全 resource に `PathMetadata{source, scope: user|project|temporary, origin: package|top-level, baseDir}`。package filter `!pattern`/`+exact`/`-exact` は「manifest の上に重ねて **narrow するだけ**」。skill は prompt に name+description のみ、本文は `read` で(progressive disclosure)、`disable-model-invocation`(モデルからは不可視、`/skill:name` のみ)、`allowed-tools`。`AGENTS.override.md` は当該 dir だけ置換 + worktree shadow 抑止。

**kyberion の現状**: facet registry(TK-04)に tenant override 層はあるが resource provenance の型なし。`restricted-skills.json` は消費者なし(PI-03)。skill 本文は pack に同梱(prompt コスト)。`AGENTS.md` は symlink 3 兄弟のみ。

**実装**: (1) `ResourceProvenance{source, scope(tenant/org/project/mission/personal), origin(builtin|plugin|tenant-overlay|generated), base_dir, trust}` を facet/skill/pipeline template loader が付与し、tenant policy は provenance で filter。(2) filter 文法 `!`/`+`/`-` を `restricted-skills.json`/`tenant_overrides` に統一し「広げられない」ことをテスト。(3) skill を pack では見出し+説明のみにし本文は `knowledge.read` op で(読取が audit 点になる)、`disable_model_invocation`/`allowed_tools` frontmatter。(4) `AGENTS.override.md` per-directory を context loader に。

### PI-10: model runtime の graded 能力・constrained sampling・per-model compat(P1 / M)

**pi の設計**: `thinkingLevelMap` は省略=provider 既定 / 文字列=wire 値 / `null`=非対応(UI から隠す)(`packages/ai/src/types.ts:805`)。`Tool.constrainedSampling: false | {json_schema, strict: prefer|require} | {grammar}` を model 能力フラグ `supportsStrictTools/supportsGrammarTools` で gate(`api/constrained-sampling.ts` は非対応 schema 構文を拒否)。`models.json` は JSONC で per-model `baseUrl/headers/compat/samplingParams/cost`。ETag 再検証 catalog と generation-checked `publish()`。

**kyberion の現状**: `backend-capability-profile.ts` は boolean(`structured_output/abort/images`)。構造化出力は事後 validate。model 別 override/compat なし。catalog 更新機構なし。

**実装**: (1) capability profile に graded 軸(`thinking_levels: {level: wire|null}`, `strict_tools`, `grammar_tools`)を追加し `reasoning-route-resolver` が非対応 level を clamp/隠す。(2) `delegateStructured` に `strict: prefer|require` を追加し、対応 backend では provider 側 constrained sampling、非対応では既存 validate。(3) `model-registry.json` に per-model `compat/overrides`、更新は `publish()` 型の世代検査。受入: `require` を非対応 backend に出すと fail-closed、`prefer` は degrade。

### PI-11: `pnpm auth check` と provider 層 retry の明示分離(P1 / S)

**pi の設計**: `pi auth check --provider --model --json --min-expiry`(OAuth 既定 refresh)、`print-api-key/print-bearer-token` で外部 client へ資格情報を輸出。`retry.provider.maxRetries` 既定 0 —「SDK/provider retry が quota error を握り潰し agent が provider の quota reset まで block される」ため(`settings.md:141-150`)。retry は正規化された `AssistantMessage` に対して行い quota error は除外。

**kyberion の現状**: `backend-conformance.ts` は binary/version probe、資格情報の生存確認なし。failover chain は agent 層、各 CLI/SDK の内部 retry は未宣言(quota 到達を failover が見られない可能性)。`run:doctor` は環境変数を見る。

**実装**: `pnpm auth check [--backend <mode>] [--json]` を `backend-conformance` に追加(mode 別 credential 有効性・期限・refresh)、baseline-check L(Configuration)に接続。各 backend adapter に `provider_retry: {max_retries: 0 既定}` を宣言し、quota/rate 系 error は failover に必ず伝播することをテスト。

### PI-12: 供給網ゲート(P1 / S)

**pi の設計**: `.npmrc` `save-exact=true`, `min-release-age=2`; `check-pinned-deps.mjs`; lockfile commit gate(`PI_ALLOW_LOCKFILE_CHANGE=1` 以外は pre-commit で拒否); `allowedInstallScriptPackages: Map<pkg@version, 理由文>` で lifecycle script を allowlist(消えた entry もエラー、`--ignore-scripts` 常時); 決定的 source archive + `SHA256SUMS`(CI で `sha256sum -c`); `release:local`(repo 外 dir へ pack→install、npm/Bun 両方)。

**kyberion の現状**: `validate` の check 群にこれらは無い。`KYBWEION_PRODUCT_RELEASE_GOVERNANCE` は手順書。

**実装**: `check:pinned-deps`、`.npmrc` に `minimum-release-age`(pnpm 相当)、lockfile 変更 gate(env で明示解除)、pnpm `onlyBuiltDependencies` を理由文付き allowlist として `knowledge/product/governance/install-script-allowlist.json` に外出しし checker で突合、`release:local` smoke、release workflow に source archive + SHA256SUMS。

### PI-13: backend conformance を実行可能仕様へ(P1 / M)

**pi の設計**: `server/src/testing/`(`createTestServer`, `WireChannel` 契約)、`telemetry/src/testing/conformance.ts`、`harness/session/testing/` を **package export** し、第三者実装も同じ suite を走らせる。

**kyberion の現状**: `backend-conformance.ts` は CLI の binary/version/help を probe し、`abort/session continuity/images` は「宣言」のまま(コメントに明記)。20 mode に対し「全 mode が通す実行可能な契約 suite」は無い。

**実装**: `libs/core/testing/reasoning-backend-conformance.ts` に `runReasoningBackendConformance(backend, {live?: boolean})`(structured output round-trip・abort・failover 伝播・egress scope 尊重・usage 報告)を置き、stub で常時、live は `PROVIDER_LIVE=1` で。QM-06 の evidence を「宣言」から「verified」に昇格。

### PI-14: manual drive と approval gate の接続(P2 / M)

**pi の設計**: `drive: manual` で `peekAction()` が次の `ActionInfo{kind: append_entry|stream_assistant|execute_tool|hook|sleep|apply_pending_write|consume_queue_item, …}` を返し `executeAction()` で 1 歩進む。

**kyberion の現状**: pipeline dry-run はあるが worker の 1 歩実行なし。TK-03 `await_decision` は pipeline 層の suspend。

**実装**: `agent-runtime` の worker loop に `mode: auto|step` と `peek()`、approval gate は `peek().kind === 'execute_tool'` の時点で `approval-store` に問い合わせ(TK-03 と統合)。Chronos live intervention(SU-02)から「次の一手を見て許可/拒否/修復」できる。

### PI-15: steer / followUp / nextRun の 3 キュー(P2 / M)

**pi の設計**: `nextRun` は operation を跨いで生存(`runId` を持たない唯一の `QueueEnqueuedRecord`)。`cancelQueued` は 3 値。`shouldStopAfterTurn` は stream/tool を止めない協調的 yield。

**実装**: worker dispatch に `deliver_as: steer|follow_up|next_run` を追加、`next_run` は mission-local storage に永続し worker 再起動後の最初の run で消費。`cancel` は `cancelled|already_consumed|already_cleared` を返す。SO-03 steering を `steer` に統合。

### PI-16: fencing token 付き writer lease(P2 / S)

**pi の設計**: `INSERT … ON CONFLICT DO UPDATE SET fence = fence+1 WHERE expires_at_ms <= now RETURNING …`、更新は `owner_id AND fence` で gate(`sqlite-node/src/sqlite/storage/writer-leases.ts`)。

**実装**: mission state / journal writer に `{owner_id, fence, expires_at}` lease を導入(既存 sqlite history store 上か JSON + atomic rename)、supervisor は fence 不一致の zombie 書き込みを拒否。EV の `acquireLock` を lease API に統合。

### PI-17: deferred tool loading(P2 / M)

**pi の設計**: 「tool call 中の active tool set の **additive** 変更」を信号に、対応モデルへ `defer_loading`/`tool_reference`(Anthropic)や `tool_search_call`(OpenAI)を tool-result 位置に出し cached prefix を維持。非 additive は全量再送に fallback。`promptSnippet` 付き tool は system prompt を再構築するので prefix を壊す(文書化)。

**実装**: MCP catalog / skill-wrapper で role 別に「最小 active set + `tool_search`」を既定にし、追加は additive のみ・system prompt 非改変を規約化。対応 backend(anthropic API / claude-cli)で cache-hit 率(PI-01)が改善することを計測して既定化を判断。

### PI-18: eval harness table と multi-step eval(P2 / S)

**pi の設計**: `createPiCodingAgentHarness({name, model, noTools, transformSystemPrompt})` を「名前付き構成」とし `evalHarnessTable` + `describe.for` で同一入力を構成違いで比較、`run([{prompt},{reload},{prompt}])` で再起動を跨ぐ resource 取込を検証、`.eval/runs.jsonl` に session 添付。

**実装**: `eval/facets` に「構成 table」(persona/policy/model/knowledge slice の組)を導入し同一 brief を横断比較、`reload` step で facet/tenant overlay の hot-apply を検証。TK-11 と統合。

### PI-19: 並走セッションの git 禁止動詞を guardrail へ(P2 / S)

**pi の設計**: `AGENTS.md:51-71` — 同一 cwd で複数セッションが並走する前提で「自分がこのセッションで変えたファイルだけを明示 path で stage、`git add -A/.` `reset --hard` `checkout .` `clean -fd` `stash` `commit --no-verify` は禁止、他人のファイルの conflict は abort して聞く、PR review で worktree を動かさない」。

**kyberion の現状**: co-execution contract は「誰が git を触れるか」(mission owner のみ)を規定するが、権限者であっても爆発半径が claim を超える動詞の列挙はなく、prose のみ。

**実装**: `adf-guardrails.ts` の shell 層に git 禁止動詞リスト(`reset --hard`, `checkout .`, `clean -f*`, `stash`(create 以外), `add -A|.`, `commit --no-verify`, `push --force*`)を追加し、mission owner でも approval なしでは拒否。co-execution contract に「明示 path stage」「他所有ファイル conflict は abort」を追記。

## 3. pi から「思想として」持ち込むもの(コード変更を伴わない採択)

- **「records と entries を分ける」**: orchestrator の意図と会話は別ログ。復元は意図ログだけを読む。→ 全 journal/receipt 設計の指針(PI-05 の前提)。
- **「復元は修復せず拒否する」**: 不可能な状態は fail-closed。→ scope 契約(EG/KS)と同じ原則を実行ログへ。
- **「snapshot が正、event は hint」**: 複数 surface(Chronos/Slack/voice)は snapshot に収束させる。→ CE/SU 系 UI の設計指針。
- **「preflight は直列、実行は並列」**: 方針判断は監査可能な順序で、実行だけ並列。→ tool/op gate の規約。
- **「人不在は拒否」**(`!hasUI → block`)、**「非対話では prompt しない・ignore/deny を明示」**。→ mission worker の approval 既定。
- **「narrow only」**: overlay/override は能力を狭めるだけで広げない。→ tenant_overrides / restricted-skills / facet 層の不変条件。
- **「settled ≠ end」**: retry/圧縮/follow-up が終わるまで完了扱いしない。→ governance receipt の発火点。
- **「provider 層の retry は 0、agent 層で制御」**: 下位が error を握ると上位の failover が盲目になる。
- **「AGENTS.md は AI 貢献者との契約」**: no `any`・inline import 禁止・「全文を読んでから広範囲変更」・並走 git 規律・「The One Rule: 理解していないコードを出すな」。→ kyberion `AGENTS.md`/working-principles へ表現を借用。
- **「破壊的変更には before/after の移行コードを changelog に同梱」**(pi 0.84.0 の `context.publish()` 例)。→ release governance の changelog 規約。
- **「pi は権限システムを持たない」という選択の裏返し**: kyberion の governance 層は製品そのものであり、薄くしない。

## 4. 非採用(理由付き)

| 項目                                                                                      | 理由                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CBOR + 独自 framing(`packages/protocol`)                                                  | pi は browser/Node/Bun/Deno を zero-dep で跨ぐため必要。kyberion の surface は HTTP/WS/Slack で、セキュリティ敏感なパーサを抱える利益がない。「厳密 subset・上限宣言・未知 property 拒否」の思想だけ JSON Schema に反映 |
| Unix socket first + 認証を FS 権限に委譲                                                  | 単一ユーザ daemon には妥当。tenant chain の fail-closed 認可には identity が **プロトコル内**に要る                                                                                                                     |
| 「権限システム非搭載、container で」「No sub-agents / No plan mode / No to-dos / No MCP」 | kyberion は多エージェント mission orchestration + governance が領域。pi 自身も subagent example の修正を 3 件出荷しており、抽象を持たないコストは消えていない                                                           |
| `~/.pi/agent/` 単一ユーザ home 状態(trust.json/settings/sessions)                         | tenant 区画と矛盾。KS/KO で確立した physical namespace を使う                                                                                                                                                           |
| 正規表現ベースの command allow/deny(`plan-mode/utils.ts`, `permission-gate.ts`)           | UX の speed bump としては可、governance 制御としては不可(`curl` が safe、`find -exec` 許容)。kyberion の shell guardrail は parse ベースを維持                                                                          |
| char/4 単独の token 推定                                                                  | pi でも provider usage の**補正項**としてのみ成立。20 mode(claude-cli/codex は usage を返さないことがある)で単独使用すると圧縮/spend guard が誤発火。hybrid 構造のみ採る(PI-04)                                         |
| 圧縮 prompt をソース内定数で持つ                                                          | governance 製品では版・出所・role 差分が要る。knowledge store に置く(pi 自身の `session_before_compact` hook がその逃げ道)                                                                                              |
| `AgentHarness` 実装の fork                                                                | scaffold(全 op が `HarnessNotImplemented`)。型・record log・reducer・telemetry schema を採り、runtime は待たない                                                                                                        |
| 貢献者 auto-close gate                                                                    | 高流量 OSS tracker 向け。kyberion は PR/tenant 対面で監査痕跡を消せない。「capability を git commit で付与」だけ借りる(release governance に任意)                                                                       |
| 破壊的変更の高頻度(3 か月で 6 回)、`declare module` による message 型拡張、TUI 結合 API   | governed platform には不適。plugin は provenance 付き registry で                                                                                                                                                       |

## 5. 実施形態

- **Wave 0(P0、S〜M、独立並列可)**: PI-01(会計)/ PI-02(wire error)/ PI-03(trust set + restricted-skills 消費者)。いずれも既存 store/route の局所変更で、金銭・漏洩・権限に直結。
- **Wave 1(P1)**: PI-04(圧縮)→ PI-06(trace schema、TK-10 の前提)→ PI-08(lifecycle 図 + preflight repair + settled)→ PI-09(provenance/narrow-only/progressive disclosure)→ PI-10/11(model runtime + auth check)→ PI-12(供給網)→ PI-13(conformance)。PI-05(record log/reducer)は L で最後、EG の migration mission と歩調を合わせる。
- **Wave 2(P2)**: PI-07(Chronos snapshot 契約)→ PI-14/15/16(manual drive・3 キュー・fencing lease は同じ worker runtime 変更でまとめる)→ PI-17/18/19。
- 実装は subagent 委譲 + orchestrator レビュー方式(ファイル所有分離、PI 単位 commit、wave ごと gate)。各 PI は「テスト追加 → 実装 → checker/validate 緑 → 本文書の実装状況に証跡」で閉じる。
- 分析用 clone `active/shared/tmp/pi` は本計画確定後に削除してよい(参照は commit hash と path で残す)。

## 6. 実装状況(2026-08-16)

- 2026-08-16: read-only 分析(3 経路: agent/server/protocol/telemetry/evals、coding-agent の extension/resource/trust/safety、直近 3 か月の方向性と model runtime・供給網・コミュニティ工程)に基づき策定。kyberion 側の該当箇所は実コードで突合(`model-cost-registry.json` 段階制 0・cache 区分なし、`worker-context-compaction.ts:167` char/4、`mission-orchestration-journal.ts` 3 状態、`backend-conformance.ts` probe のみ、`restricted-skills.json` 消費者 0、`.github/workflows` に lockfile/pinned gate なし)。実装未着手。

## 7. 検証コマンド(実装時)

- PI-01: `pnpm vitest run libs/core/spend-guard.test.ts libs/core/metrics.test.ts libs/core/cost-report.test.ts` + tier 境界 fixture
- PI-02: `pnpm run check:wire-error-boundary`(新設)+ MCP/Chronos route tests
- PI-03: `pnpm vitest run libs/core/skill-plugin-loader.test.ts libs/core/approval-gate.test.ts`
- PI-04: `pnpm vitest run libs/core/worker-context-compaction.test.ts`(5 連続圧縮 golden・overflow 1 回)
- PI-06: `pnpm run generate:trace-docs && pnpm run check:reference-drift`
- PI-12: `pnpm run check:pinned-deps check:install-script-allowlist release:local`
- PI-13: `pnpm vitest run libs/core/testing/reasoning-backend-conformance.test.ts`(stub)/ `PROVIDER_LIVE=1`(live)

## 8. 関連

- [TAKT_ADOPTION_PLAN_2026-08-16](./TAKT_ADOPTION_PLAN_2026-08-16.ja.md)(TK-03 await_decision ↔ PI-14、TK-04 facet ↔ PI-09、TK-10 OTel ↔ PI-06、TK-11 ↔ PI-18)
- [QM_ADOPTION_PLAN_2026-08-01](./QM_ADOPTION_PLAN_2026-08-01.ja.md)(QM-06 backend 能力宣言 ↔ PI-10/13、QM-07 skill pack ↔ PI-09)
- [CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09](./CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09.ja.md)(OS-05 provenance/egress ↔ PI-09)
- [KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16](./KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16.ja.md) / [KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16](./KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)(KS-13/14 ↔ PI-02/03、KO の scope 表示 ↔ PI-08 systemPromptOptions)
- [EVENT_HANDLING_UNIFICATION_PLAN_2026-08-10](./EVENT_HANDLING_UNIFICATION_PLAN_2026-08-10.ja.md)(`acquireLock` ↔ PI-16)
- [ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)(migration mission ↔ PI-05)
- `knowledge/product/governance/multi-provider-coexecution-contract.md`(↔ PI-19)
