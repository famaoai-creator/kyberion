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
last_updated: 2026-08-17
status: active
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

**実装**: mission state / journal writer に `{owner_id, fence, expires_at}` lease を導入(既存 sqlite history store 上か JSON + atomic rename)、supervisor は fence 不一致の zombie 書き込みを拒否。EV の `acquireLock` を lease API に統合。長時間 async writer 向けに fence を変えない `renewFencedWriterLease` と任意の `renewEveryMs` 自動更新、`acquired|renewed|released|rejected` lifecycle observer を提供する。

### PI-17: deferred tool loading(P2 / M)

**pi の設計**: 「tool call 中の active tool set の **additive** 変更」を信号に、対応モデルへ `defer_loading`/`tool_reference`(Anthropic)や `tool_search_call`(OpenAI)を tool-result 位置に出し cached prefix を維持。非 additive は全量再送に fallback。`promptSnippet` 付き tool は system prompt を再構築するので prefix を壊す(文書化)。

**実装**: MCP catalog / skill-wrapper で role 別に「最小 active set + `tool_search`」を既定にし、追加は additive のみ・system prompt 非改変を規約化。対応 backend(anthropic API / claude-cli)で cache-hit 率(PI-01)が改善することを計測して既定化を判断。

### PI-18: eval harness table と multi-step eval(P2 / S)

**pi の設計**: `createPiCodingAgentHarness({name, model, noTools, transformSystemPrompt})` を「名前付き構成」とし `evalHarnessTable` + `describe.for` で同一入力を構成違いで比較、`run([{prompt},{reload},{prompt}])` で再起動を跨ぐ resource 取込を検証、session 付き receipt を保存する。

**実装**: `eval/harnesses.json` に名前付き構成 table (persona/policy/model/knowledge slice の組)を追加し、`scripts/eval_harness.ts` の `runEvalHarnessTable` が同一 brief を横断比較する。`reload` step では同一 session 内で facet を再解決し、`prompt → reload → prompt` の順序と構成別の hash-only receipt を secure-io が許可する `active/shared/tmp/eval/runs.jsonl` に追記する。provider executor は注入可能で、CI では stub のまま契約を検証できる。TK-11 との評価 receipt 統合、実 provider の quality judge、tenant overlay の hot-apply 実測は未完了。

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

- 2026-08-16: read-only 分析(3 経路: agent/server/protocol/telemetry/evals、coding-agent の extension/resource/trust/safety、直近 3 か月の方向性と model runtime・供給網・コミュニティ工程)に基づき策定。kyberion 側の該当箇所は実コードで突合(`model-cost-registry.json` 段階制 0・cache 区分なし、`worker-context-compaction.ts:167` char/4、`mission-orchestration-journal.ts` 3 状態、`backend-conformance.ts` probe のみ、`.github/workflows` に lockfile/pinned gate なし)。なお `restricted-skills.json` は既存の `isSkillAllowed` → `runSkillAsync` 経路で消費されているため、PI-03 は trust resource 集合と narrow-only 不変条件の強化として継続する。
- 2026-08-17: PI-02 の `libs/core/wire-error.ts` を追加し、未知例外を固定された `busy|session_locked|not_found|invalid_request|not_implemented|internal` と相関IDへ変換。MCP共通入口および個別ハンドラの error reply を変換器へ接続し、内部の tenant/path/approval/caller-role 詳細をwireへ返さない契約をテストで固定した。Chronos API、peer messaging、境界checkerは未接続。
- 2026-08-17: PI-01 の第一段として `usage-accounting.ts` に閉じた cause 語彙(`assistant|tool|hook|compaction|branch_summary|deferred_fetch|judge|subagent|repair|adjustment`)を追加し、metrics ledger の後方互換な既定値と cost report の `by_cause` 集計を実装した。続く段として `metrics.ts` に入力 token 閾値の段階制 pricing、cache read/write/write-1h の区分、registry 注入可能な決定的テストを追加し、Anthropic SDK / Claude Agent / compaction の usage cause を接続した。実価格表は既存値を維持し、cache/tier は registry が明示した場合だけ適用する。
- 2026-08-17: PI-02 の第二段として Chronos `viewerErrorResponse`、主要な Chronos API route catch、peer messaging の responder/HTTP catch を wire-safe error (`code`/固定 message/`correlation_id`)へ接続し、checker の対象を MCP/peer/Chronos 境界へ拡張した。既存の tenant・signature 拒否コードと静的な入力エラーは互換性・監査のため維持した。
- 2026-08-17: PI-03 の第一段として `trust-requiring-resources.ts` に project-local の trust-sensitive resource 集合(`pipelines/`, `skills/`, `AGENTS.override.md`等)と決定的な descendant 判定を追加し、`evaluateSkillRestrictionRecords` で restricted skill の override 再開を禁止した。pre-trust loader 接続は未完了。
- 2026-08-17: PI-04 の第一段として `worker-context-compaction.ts` に provider usage を既知 prefix のアンカーとして保持し、未計測 tail のみを `/4` で推定する hybrid token details (`strategy`, `usageTokens`, `estimatedTrailingTokens`)を追加。`compact.before/after` と result/working-memory metadata に推定方法と内訳を記録し、従来の共通 `estimateTokens()` は互換性のため維持した。更新型要約・retained tail の自己完結化・compaction reason は未完了。
- 2026-08-17: PI-04 の第二段として `knowledge/product/prompts/worker-context-update-summary.md` を正本にした更新型要約入力(前要約・累積 `readFiles/modifiedFiles`・新 transcript・理由)を追加し、summary callback の context と summary artifact に渡すようにした。summary entry/result に `retained_tail` を保持し、carryover/working-memory に累積ファイル情報を残す。`manual|threshold|overflow` reason を event/result に記録し、mission worker の prompt-too-long 再構築は `overflow` を明示する。5 回連続 golden と overflow retry の実運用統合テストは未完了。
- 2026-08-17: PI-04 の第三段として `WorkerContextCompactor` の連続 summary path を5回反復する golden 回帰テストを追加した。各 cycle の更新型 prompt が前 cycle の governing decision を保持し、summary message と `retained_tail` が毎回 self-contained recovery に利用できることを検証した。mission worker の実 provider overflow retry との統合測定は未完了。
- 2026-08-17: PI-06 の第一段として `libs/core/trace-schema.ts` に mission/task/step/tool/compaction/judge/hook/gate の span 定義、親制約、型/cardinality/sensitive/values 属性、redaction と low-cardinality metric 投影を追加し、`persistTrace`/OTLP 投影を persistence-safe copy 経由にした。`generate:trace-docs`/`check:trace-docs` で `docs/developer/TRACE_SCHEMA.md` を schema から生成・突合する。ExactTelemetryAttributes の compile-time enforcement と replay validator への全面接続は未完了。
- 2026-08-17: PI-06 の第二段として `validateTraceAttributes` を fail-closed 化し、schema 未定義の余剰属性と `values` 外の値を runtime validator が拒否するようにした。compile-time の `ExactTelemetryAttributes` と trace tree 全体への replay validator 接続は未完了。
- 2026-08-17: PI-06 の第三段として span 定義から導出する `ExactTelemetryAttributes<kind, phase>` 型と、既知 span の属性/event・親子構造・status を検査する `validateTraceReplay` を追加した。未知の拡張 span は既定では構造検査のみ、`strictUnknownSpans` で閉じた語彙にもできる。既存の広い extension span を壊さないため、永続 trace 読み込み全体への strict validator 接続と Exact 型の全 call-site 適用は未完了。
- 2026-08-17: PI-06 の第四段として `persistTrace` の JSONL 書込み境界で `validateTraceReplay` を実行し、malformed trace を保存前に fail-closed で拒否する replay/write fixture を追加した。既存 extension span は互換性のため structural validation のままで、trace feed 全消費者の strict validation と Exact 型の全 call-site 適用は未完了。
- 2026-08-17: PI-19 の第一段として `adf-guardrails` に git co-execution guard を追加し、`reset --hard` / `checkout .` / `clean -f*` / `stash` / `add -A|.` / `commit --no-verify` / `push --force` を ADF の shell step で拒否するようにした。明示 path の通常操作は維持し、recovery surface の approval binding は別契約として残る。
- 2026-08-17: PI-13 の第一段として `libs/core/testing/reasoning-backend-conformance.ts` を追加し、stub は常時、非 stub は `live:true` の明示時だけ prompt/structured-output/abort を実行する共通 suite と結果 status を提供した。usage は provider adapter/metrics 境界の証跡が必要なため `declared` として残し、第三者 backend が同じ suite を import できる package export を追加した。
- 2026-08-17: PI-10 の第一段として backend capability profile に graded `thinkingLevelMap`、`supportsStrictTools`、`supportsGrammarTools` を追加し、未対応 thinking level の非表示判定と constrained sampling の `require` fail-closed / `prefer` fallback を共通化した。model registry/schema に per-model `compat` override (`thinkingLevelMap`/strict/grammar) を追加し、route resolver が base profile に適用する。provider 固有の native wire 送信、実モデル別 capability probe、catalog の世代付き publish は未完了。
- 2026-08-17: PI-11 の第一段として `reasoning-auth-preflight` と `pnpm auth:check` を追加した。API/endpoint は環境変数名だけを確認し、CLI は `cli-managed` として provider 側認証に分離する。credential 値・token は出力せず、実際の資格情報の有効性/期限/refresh は未完了。capability profile には provider retry `max_retries=0` / quota error propagation の宣言を追加し、orchestration 側 retry と分離した。
- 2026-08-17: PI-12 の第一段として `install-script-allowlist.json` を `pnpm-workspace.yaml` の `allowBuilds` と突合する checker、exact pnpm/lockfile/override を検査する `check:pinned-deps`、`PI_ALLOW_LOCKFILE_CHANGE=1` を明示解除に要求する lockfile gate を追加した。`minimumReleaseAge=1440` と strict mode も workspace 設定へ追加した。repo 外 pack/install smoke、source archive/SHA256SUMS、CI への全面接続は未完了。
- 2026-08-17: PI-08 の第一段として `EXTENSION_POINTS.md` に mission/task/tool lifecycle の順序図を追加し、`check:extension-order` を CI/PR に接続した。`runOpPreflight` は直列 listener の修復結果を allow/block/ask いずれでも `repaired_input` として返し、`terminate` を保持する。pipeline は fallback/repair 後に `task_settled` を一度だけ await 発火し、その後 `session_end` を実行する。tool-result の部分 patch middleware、before-agent system prompt、mission worker 全経路の settled receipt 接続は未完了。
- 2026-08-17: PI-08 の第二段として lifecycle hook の `result_patch` を追加し、`post_tool_use` / `post_tool_use_failure` の partial result middleware を pipeline の step context へ接続した。patch は shallow なキー集合だけを trace に記録し、hook telemetry の既存 fail-open を維持する。`task_settled` は既存の fallback/repair 後一回契約を維持し、before-agent system prompt と mission worker 全経路の settled receipt 接続は未完了。
- 2026-08-17: PI-08 の第三段として `before_agent_start` を lifecycle vocabulary/checker に追加し、mission worker の single-shot/goal-driven 共通 dispatch 境界で `systemPromptOptions`(metadata only)を公開した。prompt 本文は既存の visibility ledger の後段でのみ扱う。dispatch 内の retry/compaction/acceptance/rework 完了後に `task_settled` を一度発火し、observer の block は結果を遡及変更しない。mission-level の全再開経路と pipeline/worker の統合 receipt 検証は未完了。
- 2026-08-17: PI-15 の第一段として `agent-input-queue` を追加した。`steer`/`follow_up` はプロセス内、`next_run` は mission-local coordination の append-only record log とし、worker 再起動後にも run id なしで消費できる。`cancelQueued` は `cancelled|already_consumed|already_cleared` を返し、未知・壊れた record は `AGENT_INPUT_QUEUE_CORRUPT` で fail-closed にする。既存 SO-03 surface steering と worker dispatch の `deliver_as` 統合、および協調的 `shouldStopAfterTurn` は未完了。
- 2026-08-17: PI-15 の第二段として goal driver に `shouldStopAfterTurn` を追加した。現行 turn/tool 実行を中断せず、turn 完了後だけ `paused` に遷移する cooperative yield で、cold resume と併用できる。queue entry を steer/follow_up/inject として実 worker prompt/inbox へ届ける接続は未完了。
- 2026-08-17: PI-15 の第三段として mission の goal-driven worker に共有 input queue を接続した。各 turn boundary で `steer → follow_up → next_run → inject` を prompt の未信頼データとして届け、`next_run` は process restart 後も durable log から一度だけ消費する。続く段で single-shot dispatch の A2A prompt/visibility ledger にも queue payload を一度だけ接続した。surface からの steer/follow-up enqueue と task/agent 別 queue scope は未完了。
- 2026-08-17: PI-15 の第四段として SO-03 surface の明示 `steer:` / `follow-up:` コマンドを session-owned mission queue に接続した。enqueue metadata に surface/channel/thread を保持し、応答で queue 化と次の turn boundary 処理を明示する。task/agent 別 queue scope、surface 外の delivery API、自然言語を暗黙に steer へ昇格する経路は未完了。
- 2026-08-17: PI-15 の第五段として goal worker に serial `preStep` admission chain を追加した。各 hook の `enter(messages)` は順序を保持して prompt へ追加し、`reject` は backend の model/tool 呼び出しなしに pause へ遷移する。task/agent 別 queue scope、surface 外の delivery API、自然言語を暗黙に steer へ昇格する経路は未完了。
- 2026-08-17: PI-15 の第六段として queue entry に task/agent/session scope を追加し、single-shot と goal-driven worker が broadcast または対象 scope の entry だけを consume するようにした。scope mismatch は durable/volatile lane のどちらでも残留し、別 task への steer 漏れを防ぐ。surface 外の delivery API と自然言語を暗黙に steer へ昇格する経路は未完了。
- 2026-08-17: PI-15 の第七段として `enqueueSurfaceAgentInput` を追加し、surface からの明示 `steer|follow_up` delivery を queue の単一 APIへ統一した。surface/channel/thread provenance と任意 worker scope を保持し、自然言語をこの API 内で暗黙昇格しない。SO-03 の mission steering route をこの APIへ接続し、surface 外の delivery API と自然言語自動昇格は未完了のまま明示した。
- 2026-08-17: PI-08 の第四段として lifecycle outcome に `decision: allow|ask|block` / `asked` を追加し、Claude Code grouped hook と Codex normalized hook の外部設定 bridge を導入した。`deny > ask > allow` を一つの engine で集約し、非対話の pipeline/worker は ask を fail-closed で止める。interactive approval surface への ask 接続、全 external config の自動発見、sticky halt は未完了。
- 2026-08-17: PI-08 の第五段として opt-in の `stickyHalt` を lifecycle hook engine に追加した。一度の security block を明示 `clearHalt()` まで保持し、後続 hook の allow 登録や再 fire で抜け道にならないことを固定した。bridge disposer は hook unregister 後に in-flight fire を drain する。interactive approval surface への ask 接続と全 external config の自動発見は未完了。
- 2026-08-17: PI-08 の第六段として pipeline 実行入口に `before_agent_start` を接続し、prompt 本文を渡さずに pipeline/mission/resume/step metadata と `promptVisibility: ledgered` だけを hook へ公開するようにした。さらに agent start 後の pipeline failure/fallback でも `task_settled` を一度だけ発火する。suspend 前の settlement、interactive approval surface への ask 接続、全 external config の自動発見は未完了。
- 2026-08-17: PI-08 の第七段として `fireLifecycleHooksWithApproval` を追加し、明示的に interactive surface を渡した場合の lifecycle `ask` を既存 approval store の `channel-approval` request へ materialize できるようにした。correlation/channel/requester で pending request を再利用するため、retry で承認依頼を重複作成しない。通常の `fireLifecycleHooks` は従来どおり非対話境界で fail-closed のまま維持し、human-only accountability を request に付与する。全 surface adapter の実 wiring と承認後の lifecycle 再開は未完了。
- 2026-08-17: PI-05 の第一段として `mission-orchestration-journal` に `operation{id, kind, attempt}` と `outcome` を追加し、既存 replay plan を I/O なしの `reduceMissionState(records)` 経由へ切り替えた。旧 3 状態 journal は load 時に互換正規化し、失敗/中断後の再 enqueue は attempt を単調に繰り上げる。`ProvisionedEntry` の id+content hash、secure write、deep-equal 相当の verify を追加し、不一致を `MISSION_LOG_CORRUPT:provisioned_entry_mismatch`、読取不能を `MISSION_LOG_CORRUPT:provisioned_entry_unreadable` として拒否する。worker 成果物の全書込み経路への record→write→verify 接続、resume 全体の二重実行/欠落防止、手動 `reconcile-work` への自動分岐は未完了。
- 2026-08-17: PI-05 の第二段として journal JSONL の unreadable line を `MISSION_LOG_CORRUPT:journal_entry_unreadable:<line>` に正規化し、pure reducer が operation attempt の後退を `MISSION_LOG_CORRUPT:operation_attempt_regression:<id>` として拒否するようにした。pending id も event id ではなく operation id を返す。worker 成果物の全 record→write→verify 接続と resume の二重実行防止は未完了。
- 2026-08-17: PI-05 の第三段として、planner の `NEXT_TASKS.json` 保存経路(テンプレート種別の merge 経路と通常経路)を `provisioned → native JSON write → reread verify` に統一し、mission-local `coordination/provisioned-entries.jsonl` へ本文を含まない hash-bound の `provisioned`/`verified` receipt を記録するようにした。PLAN.md・TASK_BOARD.md 等の全成果物接続、resume 時の重複実行/欠落防止、手動 `reconcile-work` への自動分岐は未完了。
- 2026-08-17: PI-05 の第四段として、planner の `PLAN.md` と mission 状態更新時の `TASK_BOARD.md` を native text のまま `provisioned → write → reread verify` へ接続し、同じ mission-local receipt に対象相対パスと content hash を記録するようにした。deliverable/evidence/PR 等の全 worker 成果物、resume 時の重複実行/欠落防止、手動 `reconcile-work` への自動分岐は未完了。
- 2026-08-17: PI-05 の第五段として、worker の clarification packet、best-of alternative、PR diff/PR.md、planning gate evidence、heuristic feedback report も native JSON/text のまま provisioned receipt と reread verify に接続した。任意 deliverable の全書込みと手動 `reconcile-work` への自動分岐は未完了。
- 2026-08-17: PI-05 の第六段として、完了 receipt が存在する同一 orchestration event の再実行を journal で検出して no-op にし、resume replay の二重 dispatch/二重 `mission_controller resume` を防止した。失敗・中断 event は retry 対象に残す。resume 全体の欠落検出と手動 `reconcile-work` への自動分岐は未完了。
- 2026-08-17: PI-05/PI-16 の追加段として `provisioned-entries.jsonl` の `provisioned`/`verified` receipt append も path-derived fencing lease 下へ接続した。同期 JSONL writer の競合で intent record が欠落・交差しないようにし、mission state / orchestration journal / provisioned receipt が同じ lease 原則を共有する。任意 deliverable 全書込みと resume の欠落検出は未完了。
- 2026-08-17: PI-09 の第一段として `ResourceProvenance{source,scope,origin,base_dir,trust}` を追加し、facet resolver の tenant/product/managed/builtin 結果へ provenance を付与した。`applyNarrowOnlyFilter` は exact `!`/`-` の除外と `+` の retain を扱い、manifest にない resource の導入・除外後の再追加を `RESOURCE_FILTER_WIDENED` で拒否する。restricted-skills の宣言統合、skill の見出し+説明だけを prompt に出す progressive disclosure、`disable_model_invocation`/`allowed_tools` frontmatter、`AGENTS.override.md` loader 接続は未完了。
- 2026-08-17: PI-09 の第二段として `skill-resource-loader` を追加し、SKILL.md の frontmatter から name/description のみを model-visible index に出し、本文は明示 read でのみ取得する progressive disclosure を実装した。`disable-model-invocation`、`allowed-tools`、resource provenance を型付きで保持し、モデル経由の本文取得は `SKILL_MODEL_INVOCATION_DISABLED` で拒否する。実際の mission context pack/knowledge.read への全面接続と `AGENTS.override.md` の per-directory loader は未完了。
- 2026-08-17: PI-09 の第三段として `agent-instruction-loader` を追加し、最寄りの `AGENTS.override.md` を同一ディレクトリの `AGENTS.md` の置換として解決し、`.worktrees/` 配下では override の shadow を無効化した。`CodexExecutionEnhancer` の直読み経路を loader に接続し、選択された instruction に provenance を付与する。mission context pack の skill index 統合と knowledge.read 監査 receipt は未完了。
- 2026-08-17: PI-09 の第四段として `agent-instruction-loader`/skill loader と同じ provenance 方針で、`provisionTaskKnowledge` の model-visible 出力を mission-local `coordination/prompt-visibility.jsonl` に metadata-only receipt として記録する `prompt-visibility-ledger` を追加した。skill本文やプロンプト本文は保存せず、hash・長さ・form・context pack/task/knowledge refs のみを残す。mission context pack の skill index/knowledge.read 監査 receipt、resource filter の全面適用は未完了。
- 2026-08-17: PI-09 の第五段として `mission-context-pack` に明示 `skillPaths` の取り込みを追加し、SKILL.md の name/description/allowed-tools/disable-model-invocation/provenance を pack artifact に保持しつつ、render 時は progressive index(XML)だけを model-visible にした。skill 本文は明示 read 以外で取得されず、context pack schema と metadata-only fixture を固定した。`knowledge.read` の監査 receipt と restricted-skills / tenant overlay の全 resource filter 適用は未完了。
- 2026-08-17: PI-09 の第六段として `readSkillResourceForModel` を追加し、skill 本文の明示 model read は mission scope 必須・`disable-model-invocation` を尊重し、返却前に `skill_body` の metadata-only prompt visibility receipt を作るようにした。本文は ledger に保存せず hash/長さ/skill path のみ監査できる。実際の ADF `knowledge:read` actuator への接続と restricted-skills/tenant overlay filter の全面適用は未完了。
- 2026-08-17: PI-09 の第七段として `readSkillResourceForModel` を `isSkillAllowed` に接続し、モデル本文 read の直前に restricted-skills と tenant/org/project overlay を評価するようにした。拒否時は `SKILL_RESOURCE_RESTRICTED` で fail-closed、許可時だけ既存の metadata-only visibility receipt を作る。ADF `knowledge:read` actuator と全 resource loader への filter 適用は未完了。
- 2026-08-17: PI-09 の第八段として Wisdom の `knowledge_read` capture/direct op を追加し、ADF から skill 本文を読む経路を `security_scope.mission_id` 必須・trusted resource 限定・`readSkillResourceForModel` 経由に統一した。返却本文は context にのみ渡し、mission-local prompt visibility ledger には hash/長さ/参照先だけを記録する。全 resource loader への narrow-only filter 適用と tenant overlay の実 resource fixture 検証は未完了。
- 2026-08-17: PI-09 の第九段として `.kyberion-plugins.json` の tenant/org/project overlay を `applyNarrowOnlyFilter` に接続し、base manifest にない plugin の追加を `RESOURCE_FILTER_WIDENED` として拒否するようにした。既存 base の `-`/`!` 除外と `+` retain のみに限定し、widening は loader の設定読み取りを空集合へ fail-closed する。pipeline/template/全 skill resource loader への同一 filter 適用と tenant overlay の実 resource fixture 網羅は未完了。
- 2026-08-17: PI-09 の第十段として `mission-context-pack` の model-visible skill index と preloaded descriptor の両経路を mission の tenant/org/project scope で `isSkillAllowed` に通し、restricted-skills の対象 skill を pack から除外する fail-closed filter と fixture を追加した。pipeline/template loader と tenant overlay の実 resource fixture 網羅は未完了。
- 2026-08-17: PI-09 の第十一段として ADF の `readValidatedPipelineAdf` / `readValidatedWorkflowAdf` に明示的な `trustResolved:false` 境界を追加し、project-local pipeline/template の JSON と executable workflow module (TS/JS) を読み込む前に fail-closed で拒否するようにした。静的 `core:include` fragment にも同じ trust 判定を伝播し、pre-trust caller が pipeline/template resource を経由して読み込めない回帰テストを追加した。既存 CLI のデフォルト動作は維持し、実際の project-trust decision を全 production caller へ供給する統合は未完了。
- 2026-08-17: PI-03 の第二段として `loadAgentInstructionResource` に `trustResolved` 境界を接続した。pre-trust caller は project-local `AGENTS.override.md` を消費できず、canonical `AGENTS.md` へ戻る。override を含む trust-sensitive resource の個別 trust 決定と、skill/pipeline/plugin の全 loader への同一境界適用は未完了。
- 2026-08-17: PI-03 の第三段として `loadAuthorizedSkillPlugins` にも `trustResolved:false` の pre-trust 境界を追加した。`.kyberion-plugins.json` の存在だけを診断し、設定 selector の解析と plugin import は行わない。pipeline/template の pre-trust loader と、実際の project-trust decision を全 caller に供給する統合は未完了。
- 2026-08-17: PI-07 の第一段として Chronos mirror の `LiveSyncScheduler` に任意の snapshot revision extractor と `applySnapshot` 境界を追加した。SSE/event payload は従来どおり invalidate hint に留め、REST snapshot の revision が現在値より古い場合は state と UI callback を更新しない。各 Chronos panel の revision 付き API payload と intervention lease の統一は未完了。
- 2026-08-17: PI-16 の第一段として `writer-lease.ts` に durable `{owner_id, fence, expires_at_ms}` record と async/sync の fenced writer API を追加し、`mission-state.saveState`・`mission-orchestration-journal`・provisioned receipt・共通 `appendValidatedJournalEvent`（worker/pipeline/orchestrator/identity journal）を path-derived lease 境界へ接続した。expired lease のみ fence を進め、live lease・壊れた record・stale owner/fence は fail-closed で拒否する。agent-runtime-supervisor の所有者 ID 連携、renewal/metrics、任意 deliverable 全 writer の適用は未完了。
- 2026-08-17: PI-16 の第二段として、長時間 async writer が `renewFencedWriterLease`（または `renewEveryMs`）で同一 fence のまま TTL を延長できるようにした。自動更新は外側の保護 lock を再取得せず内部 renewal を使い、自己デッドロックを避ける。`acquired|renewed|released|rejected` の best-effort lifecycle observer と stale/expired renewal の回帰テストを追加した。第三段として agent-runtime supervisor の prewarm request id を `runtimeOwnerId` / `runtimeOwnerType` として mission team orchestrator → daemon/in-process spawn へ伝播し、runtime ownership record が要求元 process identity を保持するようにした。集約 metrics sink、任意 deliverable 全 writer の適用は未完了。
- 2026-08-17: PI-03 の第四段として pipeline reasoning の prompt visibility を mission-local ledger へ接続した。`run_pipeline` は mission path が解決できる場合のみ task/context pack/knowledge refs を reasoning call options に渡し、mission 外では暗黙の記録先を作らず従来どおり実行する。pipeline/template resource 自体の pre-trust loader と、project trust decision を全 caller に供給する統合は未完了。
- 2026-08-17: PI-03 の第五段として `loadDesktopPipeline` に `trustResolved:false` の pre-trust fail-closed 境界を追加し、`procedure-dispatcher` から trust 状態を伝播できるようにした。allowlist 検査を先に行い、許可された project-local pipeline でも trust 解決前は JSON を読まない。実際の project-trust decision を production caller 全体へ供給する統合は未完了。
- 2026-08-17: PI-03/PI-09 の第六段として `loadSkillResourceDescriptor` と `mission-context-pack` の `skillPaths` に `trustResolved:false` を伝播し、project-local `skills/` を pre-trust 時には metadata も読まず拒否するようにした。temporary/plugin resource の既存 progressive disclosure は維持し、builder と loader の回帰テストを追加した。実際の project-trust decision を全 production caller へ供給する統合と全 resource loader の網羅は未完了。
- 2026-08-17: PI-17 の第一段として `prompt-cache-discipline` に role-scoped な deferred tool plan (`active`/`deferred`/announcement) を追加し、未知 tool・role 不許可・重複 catalog を fail-closed で拒否するようにした。`ReasoningBackend.generateWithTools` の共通境界で `deferred_tool_names` を解決し、provider には role-visible な最小 active schema だけを渡し、追加候補は message tail の announcement として渡すため system prompt / stable tool prefix は変更されない。goal-driven worker から role/deferred 指定を伝播し、MCP catalog には read-only の `kyberion.capability.search` discovery surface も追加した。続く段で main worker に governed `tool_search` と注入可能な catalog callback を追加し、検索結果の role 検査・競合検査後だけを次 turn の tool catalog へ additive に追加し、governed XML announcement を prompt へ渡す回帰テストを追加した。さらに Anthropic SDK の `cache_read_input_tokens` / `cache_creation_input_tokens` を request-level `cacheStats` の hit/miss として metrics に記録し、実 provider usage に基づく cache-hit 観測テストを追加した。skill-wrapper の既定 active set、Anthropic/OpenAI の native deferred reference wire は未完了。
- 2026-08-17: PI-17 の第二段として `skill-resource-loader` の `allowed-tools` を governed catalog と突合し、role filter 後の最小 active set（許可されていれば read-only `tool_search`）と deferred tool announcement へ変換する `resolveSkillToolSurface` を追加した。未知 tool、active 不許可、role 不一致は fail-closed とし、skill の権限 frontmatter が prompt-cache discipline の tool surface を広げない回帰テストを追加した。Anthropic/OpenAI の provider-native deferred reference wire と実 provider の cache-hit 比較は未完了。
- 2026-08-17: PI-17 の第三段として shared reasoning boundary が role-filter 済みの deferred 定義を provider options へ渡すようにし、Anthropic API backend に opt-in の native wire (`defer_loading` + `tool_search_tool_bm25_20251119`) と `tool_reference` 抽出を追加した。native wire は `enableNativeDeferredTools` または `KYBERION_ANTHROPIC_NATIVE_DEFERRED_TOOLS=1` で明示有効化し、既定の message announcement/fallback を壊さない。OpenAI/Claude CLI の native wire、reference 後の tool promotion loop、実 provider cache-hit 比較は未完了。
- 2026-08-17: PI-17 の第四段として worker goal loop が provider-native `deferredToolReferences` を governed `toolSearch` で再解決し、次の turn boundary にのみ tool schema を additive promotion するようにした。reference が返った現在 turn の stable prefix は変更せず、promoted tool と metadata-only announcement を次 turn に渡す。role 検査・duplicate/conflict 検査は既存の tool-search 経路を再利用し、reference promotion の回帰テストを追加した。OpenAI/Claude CLI の native wire、実 provider cache-hit 比較、非 goal worker の promotion loop は未完了。
- 2026-08-17: PI-17 の第五段として OpenAI-compatible backend に caller-provided `ToolDefinition` の一回 turn wire (`generateWithTools`) を追加した。active tool だけを Chat Completions の function tools に投影し、`deferred_tool_definitions` は native wire 非対応のため送信せず、tool call は実行せず返却する。DeepSeek 等の local provider が goal worker の governed catalog を利用できるようになった。OpenAI Responses/Claude CLI の native deferred reference wire、実 provider cache-hit 比較、非 goal worker の reference promotion loop は未完了。
- 2026-08-17: PI-17 の第六段として Wisdom の非 goal `runReasoningLoop` にも provider-native deferred reference の promotion loop を接続した。catalog callback の配列形状・role 許可・重複定義を検査し、現在の request 完了後にだけ active tool schema へ additive に昇格する。次 iteration の prompt に governed announcement を渡し、同一 turn の stable prefix は変更しない。OpenAI Responses/Claude CLI の native deferred reference wire、実 provider cache-hit 比較、全 direct reasoning caller の promotion loop は未完了。
- 2026-08-17: PI-03 の第四段として承認境界に共通 `hasHuman()` を追加した。明示的な `hasHuman:false`/`hasUI:false`/`nonInteractive:true` は新規 human approval request の生成を拒否し、ADF の built-in approval preflight も `ask` ではなく `[HUMAN_REQUIRED]` で fail-closed にする。既存の承認済み request/cache は継続利用でき、未指定 caller の後方互換も維持する。全 direct approval caller への trusted presence signal の供給と UI surface の実 wiring は未完了。
- 2026-08-17: PI-18 の第一段として `eval/harnesses.json` と `runEvalHarnessTable` を追加した。名前付き baseline/policy-aware 構成へ同一 brief を適用し、`prompt → reload → prompt` を同一 session で実行、facet 再解決と構成別の prompt/output hash・reload count のみを secure-io 許可下の `active/shared/tmp/eval/runs.jsonl` へ記録する。外部 provider は executor 注入、既定は credential-free stub とし、`eval:harness` CLI と deterministic 回帰テストを追加した。TK-11 receipt/quality judge、実 provider wire、tenant overlay hot-apply の実測は未完了。

## 7. 検証コマンド(実装時)

- PI-01: `pnpm vitest run libs/core/spend-guard.test.ts libs/core/metrics.test.ts libs/core/cost-report.test.ts` + tier 境界 fixture
- PI-02: `pnpm run check:wire-error-boundary`(新設)+ MCP/Chronos route tests
- PI-03: `pnpm vitest run libs/core/skill-plugin-loader.test.ts libs/core/approval-gate.test.ts`
- PI-04: `pnpm vitest run libs/core/worker-context-compaction.test.ts`(5 連続圧縮 golden・overflow 1 回)
- PI-06: `pnpm run generate:trace-docs && pnpm run check:reference-drift`
- PI-12: `pnpm check -- --scope pr` (pinned dependency, install-script allowlist, and lockfile gates are manifest entries)
- PI-13: `pnpm vitest run libs/core/testing/reasoning-backend-conformance.test.ts`(stub)/ `PROVIDER_LIVE=1`(live)

## 8. 関連

- [TAKT_ADOPTION_PLAN_2026-08-16](./TAKT_ADOPTION_PLAN_2026-08-16.ja.md)(TK-03 await_decision ↔ PI-14、TK-04 facet ↔ PI-09、TK-10 OTel ↔ PI-06、TK-11 ↔ PI-18)
- [QM_ADOPTION_PLAN_2026-08-01](./QM_ADOPTION_PLAN_2026-08-01.ja.md)(QM-06 backend 能力宣言 ↔ PI-10/13、QM-07 skill pack ↔ PI-09)
- [CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09](./CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09.ja.md)(OS-05 provenance/egress ↔ PI-09)
- [KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16](../improvement-plans-archive/2026-08/KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16.ja.md) / [KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16](./KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)(KS-13/14 ↔ PI-02/03、KO の scope 表示 ↔ PI-08 systemPromptOptions)
- [EVENT_HANDLING_UNIFICATION_PLAN_2026-08-10](./EVENT_HANDLING_UNIFICATION_PLAN_2026-08-10.ja.md)(`acquireLock` ↔ PI-16)
- [ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)(migration mission ↔ PI-05)
- `knowledge/product/governance/multi-provider-coexecution-contract.md`(↔ PI-19)
