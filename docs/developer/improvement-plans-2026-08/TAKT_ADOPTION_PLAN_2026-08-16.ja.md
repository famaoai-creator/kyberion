---
title: takt 分析・採択計画(TK-01〜12)
tags:
  [
    takt,
    workflow,
    graph-orchestration,
    judge-route,
    facet,
    provider-routing,
    human-in-the-loop,
    adoption-plan,
  ]
last_updated: 2026-08-16
status: planned
---

# takt 分析・採択計画(TK-01〜12)

> **作成日**: 2026-08-16
> **分析対象**: [nrslib/takt](https://github.com/nrslib/takt) v0.59.1 @ `4ef1a08e`(clone: `active/shared/tmp/takt`、分析後に削除可)
> **位置づけ**: QM / CLAW_EMPIRE / CLOUDFLARE_OS 採択計画と同型の「外部システム分析 → kyberion への選択的取り込み」計画。対象は **ワークフロー制御語彙・プロセス拡張機構・LLM プロバイダ抽象** の 3 領域。[GRAPH_ORCHESTRATION_PLAN_2026-07-28](../improvement-plans-2026-07/GRAPH_ORCHESTRATION_PLAN_2026-07-28.ja.md)(GE-01〜09)と [LAYERED_EXECUTION_PLAN_2026-07-15](../improvement-plans-2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)(LE-01〜05)の後続。
> **前提**: kyberion の pipeline JSON / ADF / mission モデルは維持する。takt を依存として取り込む・YAML へ移行する・pipeline を takt workflow で置換することは**しない**(§4 非採用)。takt の実装そのものではなく、**宣言的な制御語彙と層状の拡張モデル**を kyberion の既存基盤(graph-scheduler / reasoning-backend / mission-gate-engine / plugin gate)に接続する。

## 1. takt とは何か(要約)

takt は「AI コーディングエージェントの _プロセス_ をプロンプトではなく宣言的 YAML に外部化する」Node ≥24 の CLI(MIT)。設計哲学は「エージェントは強力だが権威ではない」「構造 > プロンプト」「フィードバックループは一級市民」「人の判断はエスカレーション経路」。~855 の TS ファイル、en/ja 完全並行、OTel 計装、promptfoo による facet 品質評価を持つ。

ドメイン語彙は **workflow / step / rule / facet / persona / policy / knowledge / instruction / output-contract**(旧 piece / movement 語彙は破壊的変更で除去済み)。

- **workflow**: `initial_step` + `max_steps` + `steps[]` + facet 参照マップ(`personas: / policies: / knowledge: / instructions: / report_formats: / facet_pools: / schemas:`)。7 種の step kind(通常 agent / `parallel`(静的・動的 pool/selection)/ `arpeggio`(CSV/JSON バッチ + merge)/ `team_leader`(実行時分解 + バリア)/ `workflow_call`(型付き params のサブワークフロー)/ `kind: system`(エンジン直実行、`enqueue_task`/`merge_pr` 等の effects))。
- **rule**: step ごとに `rules[]`。**先勝ち・YAML 順評価・フォールバックなし**(不一致は `rule_no_match` で abort)。条件は semantic label / 決定的 `when(...)` 述語 / 並列集約 `all("X")`・`any("X")` / `ai("...")` 判定 / 複合。ループは「前の step へ戻る rule」+ `max_steps` + `LoopDetector`(連続反復)+ `CycleDetector` + `loop_monitors`(固定 persona `loop-judge` による AI 判定)で有界化。
- **人の介入**: step / rule 単位の `requires_user_input`、`interactive_only` rule、`AskUserQuestionHandler` / `PermissionHandler`(非対話実行では**自動 deny**)。
- **facet**: persona / policy / knowledge / instruction / output-contract を個別 markdown として `builtins/{lang}/facets/` に配置し、**project(`.takt/`)→ global(`~/.takt/`)→ builtin** の層で解決。`{{include:instructions/<name>}}` partial、`uses:/with:` の step fragment(スキーマ検証前に展開、64 深/512 参照/1MiB の上限と trust boundary)、`workflow_call` の型付き params(`facet_ref` / `workflow_ref` / `facet_pool_ref` / `companion_ref[]`)、GitHub パッケージ **repertoire**(`takt-repertoire.yaml` マニフェスト、`@owner/repo/name` 参照)が第 4 層。
- **provider seam**: `Provider`(`supportsStructuredOutput` / `supportsNativeImageInput` / `getRuntimeInstructions()` / `keepsAllowedToolWithoutEdit()` / `setup()` / `compactSession()`)→ `ProviderAgent.call(prompt, ProviderCallOptions)` → `AgentResponse`。`ProviderCallOptions` は `cwd / sessionId / model / allowedTools / permissionMode / mcpServers / outputSchema / onStream / onActivity / abortSignal / imageAttachments`。10 プロバイダ(claude-sdk / claude(headless CLI) / claude-terminal(tmux) / codex / opencode / cursor / copilot / kiro / pi / mock)。**step 単位で provider / model / permission を宣言的に解決するラダー**(CLI/env → promotion → step 指定 → workflow_call override → `provider_routing.steps|tags|personas` → auto-routing → workflow → project → global)。permission は `readonly|edit|full` の 3 値をプロバイダ毎にマップし、`required_permission_mode` が床。`promotion`(step 毎エスカレーション)、`rate_limit_fallback.switch_chain`、`capabilities:` プリセット(`provider_options.extends`)。
- **実行**: 1 step = 同一セッション上の 3 フェーズ(perform / report(Write のみ許可)/ status judgment)。`output_contracts.report[]`(`use_judge`)、report 継承。隔離は **`git clone --reference --dissociate`**(Claude Code が `.git` ファイルの `gitdir:` を辿って親リポジトリへ戻るため worktree を敢えて避ける)。companion reviewer(実装者と並走する read-only レビュア、diff トリガ、moderator + NDJSON mailbox、**助言のみで routing を変えない**、既定 off)。

### kyberion との構造対比

| 軸                | takt                                                                                                                                      | kyberion(現状、`origin/main` 実コード突合)                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 制御語彙          | step + `rules[]`(先勝ち・フォールバックなし・`ai()` 判定を条件に持てる)                                                                   | `core:if / switch / while / loop_until / retry_until_quality / foreach / parallel_foreach / accumulate / include`。DAG は `graph-scheduler.ts`(typed edge `control/data/when`、fan-in merge、resource-claim)。**LLM 判定→分岐の宣言構文なし**(`retry_until_quality` の `verdict ∈ {ok,pass,passed}` 固定文字列のみ)                          |
| ループ有界化      | `max_steps` + LoopDetector + CycleDetector + `loop_monitors`(AI)                                                                          | 各ループ op の `max_iterations`(**既定 1**)、`accumulate` の `dry_streak_limit`、tool-call repeat governor。graph 経路上の反復・循環検出なし                                                                                                                                                                                                 |
| 人の介入          | step/rule の `requires_user_input`、非対話は自動 deny                                                                                     | `approval-actuator`(create/decide/request_review)+ `enforceApprovalGate`(procedure-dispatcher 等から呼ばれる)。**pipeline を suspend→resume する blocking op なし**、`run_pipeline.ts` は `enforceApprovalGate` を呼ばない                                                                                                                   |
| プロンプト構成    | facet(persona/policy/knowledge/instruction/output-contract)を層状解決し、3 フェーズテンプレートに差し込む。`faceted-prompting` パッケージ | role `PROCEDURE.md` の一回注入 + `working-principles.ts` + `mission-context-pack.ts` + KP-01 知識供給 + `core:include` fragment。**pipeline step から persona/policy/output-contract を個別参照する語彙なし**、tenant 上書き層なし                                                                                                           |
| provider 抽象     | `Provider` 能力フラグ + `ProviderCallOptions` + step 単位 routing ラダー + permission 3 値 + promotion + switch_chain                     | `ReasoningBackend`(20 モード、failover chain、`backend-capability-profile.ts` の `utilityFit`、`provider-permission-profiles.ts`)。`ReasoningCallOptions = {role, profile, effort, budget, model_tier, model, …}`。**pipeline step に provider/model/permission_mode/promotion の宣言欄なし**、routing は `reasoning-route-policy.json` のみ |
| provider 別生成物 | `getRuntimeInstructions()` フック + `takt export-cc / export-codex`                                                                       | CT-01 生成儀式は `.claude/agents/` と `.agents/agents/` のみ。`.codex/` `.gemini/` は契約上「生成される」が**生成器が存在しない**                                                                                                                                                                                                            |
| 拡張パッケージ    | builtins → global → project → repertoire(GitHub, マニフェスト, `@owner/repo/name`)、`takt eject`                                          | 32 actuator + op registry SSoT、plugin provenance gate(KD-06、`pnpm plugin:install --pack`)、`pipeline-templates/` → tenant `pipelines/`。**facet 相当のパッケージ単位なし**                                                                                                                                                                 |
| 並走レビュー      | companion reviewer(diff トリガ・助言のみ)                                                                                                 | `background-review-runner.ts`(HA-01、提案のみ)— **同型で既存**。diff トリガと moderator は未整備                                                                                                                                                                                                                                             |
| 観測性 / 評価     | OTel(`workflow.*/step.*/phase.*/judge_stage.*` span、TraceQL ヒントを `meta.json` へ)、promptfoo による facet 内容評価                    | Trace(stable v1)+ replay。judge 段の span 粒度・OTLP export・facet 内容の回帰評価は要確認/未整備                                                                                                                                                                                                                                             |

**採択の基本判断**: kyberion は既に DAG スケジューラ・有界ループ・gate engine・多プロバイダ backend・plugin gate を持ち、takt より広い(mission / tenant / governance)。欠けているのは **「LLM 判定を宣言的に routing へ接続する語彙」「pipeline を止めて人を待つ op」「step 単位の facet / provider / permission 宣言」「facet を層状に解決・配布する仕組み」** という _薄い宣言層_ であり、それは既存エンジンの上に載せられる。takt の実装(YAML・独自エンジン・tmux 等)は持ち込まない。

## 2. 改善項目一覧

| ID    | タイトル                                                                   | 優先度 | 規模 | 対応する既存計画 / 基盤                                 |
| ----- | -------------------------------------------------------------------------- | ------ | ---- | ------------------------------------------------------- |
| TK-01 | 判定→分岐の宣言構文 `core:judge_route`(先勝ち・fail-closed)                | **P0** | M    | GE-03/04 後続、`delegateStructured` + `graph-scheduler` |
| TK-02 | ループ反復・循環検出と `max_iterations` 省略 lint                          | **P1** | S    | LE-04 guardrails 後続、`adf-guardrails.ts`              |
| TK-03 | 人を待つ blocking op `core:await_decision`(suspend / resume)               | **P1** | M    | MO-11 / AG 後続、`approval-gate.ts` + run journal       |
| TK-04 | facet レジストリと step 単位 `facets:` 参照(tenant 上書き層)               | **P1** | L    | KP-01/04 後続、roles/PROCEDURE.md を persona に昇格     |
| TK-05 | step 単位 provider / model / permission_mode / promotion 宣言と routing 表 | **P1** | M    | RG-01 / QM-06 後続、`provider-permission-profiles.ts`   |
| TK-06 | provider runtime-instructions フックと生成儀式の完成(`.codex/` `.gemini/`) | P2     | S    | CT-01 後続、`generate_subagent_definitions.ts`          |
| TK-07 | step の output-contract / report フェーズ分離                              | P2     | M    | TK-04 の派生、`delegateStructured` schema 参照          |
| TK-08 | 動的並列(pool / selection)と `core:team_lead` op                           | P2     | M    | MO-03 後続、`decomposeIntoTasks` 再利用                 |
| TK-09 | facet pack の外部取込(マニフェスト + `@owner/repo/name` 参照)              | P3     | S    | QM-07 / KD-06 後続、plugin gate を再利用                |
| TK-10 | 判定段・step 粒度の OTel span と OTLP export                               | P3     | S    | OP-01 後続(既存 Trace の外部化)                         |
| TK-11 | facet 内容の回帰評価ハーネス                                               | P3     | M    | QM-03 `bench:memory` と同系                             |
| TK-12 | pipeline スキーマ変更に伴うドキュメント正直性(EXTENSION_POINTS / README)   | P2     | S    | IP-07 / QM-10 後続                                      |

---

### TK-01: 判定→分岐の宣言構文 `core:judge_route`(P0 / M)

**takt の設計**: 各 step の `rules[]` を YAML 順に先勝ち評価。条件は semantic label(エージェント応答の分類)/ 決定的 `when(...)` / 並列集約 `all()`・`any()` / `ai("...")`(judge 呼び出し)。**一致なしはフォールバックせず `rule_no_match` で abort**(暗黙の継続を禁じる)。judge は固定 persona で走り、判定は構造化出力。

**kyberion の現状**: LLM 判定で経路を変えるには `core:retry_until_quality`(`ctx.verdict` の固定文字列比較)か、`delegateStructured` の結果を `core:switch` / `when` edge へ手配線するしかない。条件文法(`logic-utils.ts` `evaluateCondition`)は式を禁じており構造演算子のみなので、判定ラベル→分岐の対応表を毎回 switch で書くことになる。best-of + judge は `mission-orchestration-worker.ts` にのみ存在し pipeline op ではない。

**実装**:

1. `core:judge_route` op を追加。`params = { judge: {role|persona, schema_ref, prompt|instruction_ref, inputs}, routes: [{when: {label|field, eq|in|matches…}, next: <step_id> | COMPLETE | ABORT, reason?}], on_no_match: "abort" }`。判定は `delegateStructured`(`utilityFit: judge` の backend を優先、`context_mode: advisory` 不可)で取り、`routes` を **配列順・先勝ち**で評価、`on_no_match` の既定は `abort`(fail-closed)。判定結果と選ばれた route を run journal / Trace に記録。
2. `graph-scheduler.ts` の `when` edge に `judge_route` の出力チャネル(`{label, confidence, rationale}`)を `consumes` できるようにし、既存 DAG 上で「judge ノード → 条件付き後続」を型付き edge として表現可能にする(`deriveExecutionGraph` の validation に `unreachable-route` を追加)。
3. `retry_until_quality` は内部で `judge_route` の特殊形として実装し直し(互換維持)、固定文字列比較を廃す。
4. `pipeline-adf.schema.json`(`additionalProperties: false`)へ op params を追加、`adf-guardrails.ts` に「`routes` に COMPLETE/ABORT 以外の未定義 step_id」「`on_no_match: continue` の明示指定は警告」を追加。

**受入条件**: (1) ラベル→3 経路の pipeline がテストで正しく分岐し、一致なしで abort する。(2) `retry_until_quality` の既存テストが無変更で通る。(3) dry-run で `unreachable-route` が検出される。(4) stub backend でも決定的に動く(判定は fixture 注入)。

### TK-02: ループ反復・循環検出と `max_iterations` 省略 lint(P1 / S)

**takt の設計**: `max_steps`(`infinite` も可)に加え、`LoopDetector`(同一 step の連続反復)、`CycleDetector`(step 列の周期検出)、`loop_monitors`(AI 判定でループの生産性を評価し打ち切り)。

**kyberion の現状**: 各ループ op は `max_iterations` を持つが**既定 1**(省略すると 1 回で終わり、著者は「ループが回らない」ことに気付きにくい)。tool-call の repeat governor はあるが、graph 経路(TK-01 の judge_route で後戻りするケース)の反復・循環検出はない。

**実装**:

1. `adf-guardrails.ts` に `loop-max-iterations-omitted`(warning)を追加。`core:judge_route` で後戻り可能な pipeline には `max_route_hops`(既定: steps 数 × 3)を要求。
2. `graph-scheduler.ts` の実行ループに「同一 step 連続 N 回」「step 列の周期反復」の検出器を追加し、閾値超過は `loop-detected` で abort(reason を journal へ)。
3. `loop_monitor` は TK-01 の judge を再利用し、任意で `params.loop_monitor: {every: n, judge: {...}}` を受け付ける。

**受入条件**: 省略時 lint がテストで発火。judge_route の A→B→A→B が周期検出で停止するテスト。

### TK-03: 人を待つ blocking op `core:await_decision`(P1 / M)

**takt の設計**: step / rule の `requires_user_input`、`interactive_only` rule。非対話実行では `AskUserQuestionHandler` / `PermissionHandler` が**自動 deny**(黙って続行しない)。`takt list` から merge / retry / requeue / force-fail / instruct を後出しで指示できる。

**kyberion の現状**: `approval-actuator` の `create / decide / request_review` と `enforceApprovalGate` はあるが、pipeline はそれを呼んで**続行または失敗**するだけで、「決定が来るまで止まり、決定で再開する」形がない。`run_pipeline.ts` は `enforceApprovalGate` を呼ばない。MO-11 で alignment 承認を approval-store + `command_succeeds` gate に載せた基盤がある。

**実装**:

1. `core:await_decision` op: `params = {approval: {kind, summary, options?, decision_rights_ref}, timeout, on_timeout: abort|deny|escalate, non_interactive: deny}`。approval-store に request を作り、run を `suspended` 状態で `pipeline-run-journal.ts` に永続化して終了する(プロセスを保持しない)。
2. 決定は既存の `approval:decide`(HTTP surface / CLI / Chronos)経由。決定イベントを EV(EVENT_HANDLING_UNIFICATION)のトリガ経路に流し、`resumeCompletedNodeIds` で当該 pipeline を再開する。
3. `KYBERION_NON_INTERACTIVE=1` 等の非対話環境では既定 deny(fail-closed)。決定は HMAC 付き(`mission-gate-engine` の human override 署名を再利用)。

**受入条件**: suspend → decide → resume の統合テスト(journal 経由でプロセス跨ぎ)。非対話で deny になるテスト。timeout 分岐テスト。

### TK-04: facet レジストリと step 単位 `facets:` 参照(P1 / L)

**takt の設計**: persona / policy / knowledge / instruction / output-contract を**個別の markdown facet**として配置し、workflow から名前で参照。解決は project → global → builtin の層状で、`takt eject` で下層をコピーして上書き。`{{include:...}}` partial と `uses:/with:` fragment で再利用。facet の純度規約(persona に手順を書かない等)を `coder-decisions.md` の ADR で守る。

**kyberion の現状**: 役割 persona は `knowledge/product/roles/<role>/{mission.md, PROCEDURE.md}`(27)、team role は `orchestration/team-roles/`、規範は `working-principles.ts`、知識は KP-01 の供給、fragment は `core:include`。しかし **pipeline step からは `role` しか指せず**、persona / policy / instruction / output-contract を個別に選んで合成する語彙がない。tenant が persona や policy を上書きする層もない(pipeline 自体は tenant 別に置ける)。

**実装**:

1. `knowledge/product/facets/{personas,policies,instructions,output-contracts}/<name>.md`(frontmatter: `title / kind / tags / purity`)を新設。既存 `roles/<role>/PROCEDURE.md` は persona facet への薄い参照に段階移行(移行中は両方を `syncRoleProcedure` が受け付ける)。
2. pipeline step schema に `facets: {persona?, policies?: [], instructions?: [], output_contract?}` を追加。解決順は **tenant(`knowledge/confidential/{tenant}/facets/`)→ product(`knowledge/product/facets/`)→ 組込既定**。tier 越えは既存の tier 規則に従い、confidential facet が public pipeline から参照された場合は deny。
3. `mission-context-pack.ts` の役割注入と `working-principles.ts` の addendum を facet 解決器経由に一本化(単一の `resolveFacets(step, scope)`)。`core:include` は fragment 用として残し、facet 内 partial は `{{include:facets/...}}` で同じ解決器を通す。
4. facet の純度 lint(persona に手順、policy に成果物形式を書かない)を `check:` スクリプトに追加。

**受入条件**: tenant facet が product facet を上書きするテスト / tier 越え deny テスト / 既存 role 注入の回帰テスト無変更 / lint がサンプル違反を検出。

### TK-05: step 単位 provider / model / permission_mode / promotion 宣言と routing 表(P1 / M)

**takt の設計**: step 単位に `provider` / `model` を宣言でき、解決ラダーは CLI/env → promotion → step → workflow_call override → `provider_routing.steps|tags|personas` → auto-routing → workflow → project → global。permission は `readonly|edit|full` の 3 値を各 provider の実際のモードへマップし、`required_permission_mode` が床。`promotion` は step 毎のエスカレーション(後勝ち)、`rate_limit_fallback.switch_chain` はレート制限時の切替列、`capabilities:` プリセットは `provider_options.extends` で継承。

**kyberion の現状**: backend は 20 モード + failover chain + `backend-capability-profile.ts` + `provider-permission-profiles.ts` と十分に厚いが、**pipeline step には `role / op / effort / budget` しかなく、provider・model・permission の宣言欄がない**。routing は `reasoning-route-policy.json` の全体設定で、step / tag / persona 単位に効かせられない。

**実装**:

1. step schema に `reasoning: {provider?, model?, model_tier?, permission_mode?: readonly|edit|full, promotion?: [{after_failures|after_iterations, provider|model}], tags?: []}` を追加。`permission_mode` は `provider-permission-profiles.ts` の投影に渡し、**tier / tenant policy が許す範囲より緩くはできない**(床は policy 側)。
2. `reasoning-route-policy.json` に `routing: {steps: {}, tags: {}, personas: {}}` を追加し、解決順を **env → promotion → step → routing(steps→tags→personas)→ pipeline 既定 → policy** として `resolveReasoningBackendModeFromContext` の周辺に `resolveStepReasoningRoute()` を実装。決定は Trace に「どの層が効いたか」を記録(QM-09 gap accounting と整合)。
3. `capabilities:` プリセット相当は既存 `subagent-capability-profiles.ts`(KD-05)を pipeline からも参照可能にする(`reasoning.capability_profile`)。

**受入条件**: 同一 pipeline で step 毎に別 provider が選ばれる統合テスト(stub 2 系統)/ permission 床が policy より緩い指定を拒否するテスト / promotion が n 回失敗後に切替わるテスト。

### TK-06: provider runtime-instructions フックと生成儀式の完成(P2 / S)

**takt の設計**: `Provider.getRuntimeInstructions()` がプロバイダ固有の注意書きをプロンプトへ差し込む。`takt export-cc / export-codex` で同一 workflow を各 CLI の skill 形式へ書き出す。

**kyberion の現状**: 生成儀式(CT-01 `generate_subagent_definitions.ts`)は `.claude/agents/` と `.agents/agents/` のみを生成し、`multi-provider-coexecution-contract.md` が「儀式で再生成される」と宣言する `.codex/` `.gemini/` の生成器がない(契約と実装の乖離)。プロバイダ固有の注意書きは各 backend に散在。

**実装**: (1) `ReasoningBackend` に任意の `getRuntimeInstructions(): string[]` を追加し、`buildWorkingPrinciplesLines` の後段で合成。(2) 生成儀式に codex / gemini エミッタを追加するか、契約側から `.codex/` `.gemini/` の記述を削って正直化するかを決め(現状の実配線を見て決定)、`check:subagent-definitions` の drift 検査対象を揃える。

**受入条件**: 契約文書と生成物の一致を検査する check が CI にある。

### TK-07: step の output-contract / report フェーズ分離(P2 / M)

**takt の設計**: 1 step = perform → report(Write のみ許可の別フェーズ、`output_contracts.report[]` に `format / use_judge / order`)→ status judgment。report は次 step に継承される。

**kyberion の現状**: `delegateStructured` で schema 付き出力は取れ、mission 側は hash-bound evidence を持つが、pipeline step に「成果物の形式契約」と「実行と報告の分離」の宣言がない。

**実装**: TK-04 の `output_contract` facet を、step 完了後の report サブフェーズ(read-only + 成果物 Write のみの permission)として実行し、`schema_ref` は `knowledge/product/schemas/` を参照。`use_judge: true` は TK-01 の judge を report 検証に再利用。

**受入条件**: report フェーズが perform フェーズと別 permission で走るテスト / schema 違反が repair 経路(`adf-repair-agent`)へ回るテスト。

### TK-08: 動的並列(pool / selection)と `core:team_lead` op(P2 / M)

**takt の設計**: `parallel:` の動的形(`fixed` / `pool` / `selection` — 実行時に候補プールから選ぶ)、`arpeggio`(データ駆動バッチ + `merge.strategy`)、`team_leader`(実行時にタスク分解 → worker 部分 → バッチバリア、`max_concurrency` ≤ 3)。

**kyberion の現状**: `core:parallel_foreach`(既知リスト)+ merge policy、`core:accumulate` はある。実行時分解は mission orchestration(`decomposeIntoTasks`、MO-03 DAG dispatch)側にあり、pipeline 語彙にない。

**実装**: `core:parallel_foreach` に `items_from: {pool_ref | selection: {judge}}` を追加(選択は TK-01 judge)。`core:team_lead` op は `decomposeIntoTasks` で分解 → 各部分を `parallel_foreach` → `merge` の糖衣として実装し、`max_concurrency` の上限を governance envelope から取る。

**受入条件**: 動的 pool から選ばれた項目のみ実行されるテスト / team_lead の分解→合流テスト。

### TK-09: facet pack の外部取込(P3 / S)

**takt の設計**: repertoire = GitHub リポジトリ + `takt-repertoire.yaml` マニフェストを第 4 層として導入、`@owner/repo/name` で参照。

**kyberion の現状**: QM-07 で `pnpm plugin:install --pack <git url>` と provenance gate(KD-06)がある。facet(TK-04)は対象外。

**実装**: plugin pack マニフェストに `facets/` セクションを許可し、取込先を `active/shared/plugins/managed/<id>/facets/` とし、TK-04 の解決器に「managed pack 層」(tenant → product → managed → 組込)を追加。承認前は解決対象外。

**受入条件**: 未承認 pack の facet が解決されないテスト。

### TK-10: 判定段・step 粒度の OTel span と OTLP export(P3 / S)

**takt の設計**: `workflow.<name>` / `step.<name>` / `phase.*` / `judge_stage.*` の span、`monitorJsonMetricExporter`、TraceQL 発見ヒントを `meta.json` へ保存。`docker-compose.observability.yml` で `otel-lgtm`。

**kyberion の現状**: Trace(stable v1)と replay はあるが、OTLP export と judge 段の span 粒度は要確認。

**実装**: 既存 Trace を OTLP へ橋渡しする exporter(opt-in、`OTEL_EXPORTER_OTLP_ENDPOINT`)を追加し、TK-01/03/07 の judge / await / report を span として切る。**既存 Trace 形式は変えない**(stable 契約)。

### TK-11: facet 内容の回帰評価ハーネス(P3 / M)

**takt の設計**: promptfoo(~50 config)で「facet の _内容_ が良いエージェント出力を生むか」を測る。mock E2E(エンジン機構)と明確に分離。

**kyberion の現状**: hermetic テストと QM-03 の記憶ベンチはあるが、persona / policy 内容の回帰評価はない。

**実装**: TK-04 の facet に対して `eval/facets/<name>/` の fixture + 期待判定を置き、非 stub backend で任意実行(CI 必須にしない)。判定は TK-01 の judge を流用。

### TK-12: pipeline スキーマ変更に伴うドキュメント正直性(P2 / S)

TK-01/03/04/05/07/08 で `pipeline-adf.schema.json` を拡張するため、同時に次を是正する: `docs/developer/EXTENSION_POINTS.md` §2.2(op 形が `domain.action` と古い、上位キー一覧が現スキーマと不一致)、`pipelines/README.md` の "Promoted (pipeline:promote)" 空表、op 発見が `actuator-op-registry.json` / `actuator-op-discovery.json` / `CAPABILITIES_GUIDE.md` の 3 箇所に割れている点の索引化。QM-10 の正直性テストに「schema 上位キー ⊆ EXTENSION_POINTS 記載」を追加。

## 3. takt から「思想として」持ち込むもの(コード変更を伴わない採択)

- **フォールバック禁止・fail-closed の routing**: 「一致する rule がなければ abort」。kyberion の working philosophy(「done には証跡」「壊れた契約を再試行しない」)と同型で、TK-01 の既定を `abort` にする根拠。
- **エージェントは強力だが権威ではない**: 判定(judge)と実行(perform)を別 persona・別 permission で分ける。TK-07 の根拠。
- **facet の純度**: persona に手順を、policy に形式を書かない。`coder-decisions.md` の ADR の考え方を TK-04 lint に反映。
- **助言と裁定の分離**: companion reviewer は routing を変えない。kyberion の HA-01(background review は提案のみ)と一致しており、この線を維持する。
- **隔離の落とし穴の記録**: 「Claude Code は `.git` ファイルの `gitdir:` を辿って親リポジトリへ戻るため worktree 隔離が破れる」。kyberion の per-mission Git / provider 共存契約(`.git` は mission owner のみ)の注意書きとして `multi-provider-coexecution-contract.md` に追記する(実装変更なし)。

## 4. 非採用(理由付き)

| 項目                                                        | 理由                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| pipeline JSON → takt 形式 YAML 移行 / takt を依存に追加     | pipeline-adf.schema は stable 契約。必要なのは語彙の追加であり形式の置換ではない。`faceted-prompting` npm も同様に持ち込まない。 |
| `git clone --reference --dissociate` への隔離方式変更       | kyberion は mission 単位 Git + provider 共存契約で解決済み。落とし穴の記述のみ採用(§3)。                                         |
| `claude-terminal`(tmux)/ OpenCode server pool / TUI         | kyberion の surface(Chronos / CLI / MCP / ACP)と重複。                                                                           |
| `kind: system` の effects(`merge_pr` 等)を pipeline に直接  | kyberion では actuator op(git / approval)として既に governed。effects 語彙は追加しない。                                         |
| project → global(`~/.takt`)→ builtin の「ユーザーホーム層」 | kyberion のスコープは tenant / product / managed pack であり、ホームディレクトリ層は tier モデルと衝突する。                     |

## 5. 実施形態

work-scope-policy に照らし、TK-01〜05 は pipeline スキーマ・graph-scheduler・reasoning-backend の変更を伴うため **mission**(`MSN-TAKT-ADOPT-YYYYMMDD`)。ウェーブ分割:

```
Wave 1 (P0/P1 制御語彙):  TK-01 judge_route ─┬─→ TK-02 loop 検出/lint
                                              └─→ TK-03 await_decision
Wave 2 (P1 宣言層):        TK-04 facet registry ──→ TK-05 provider routing ──→ TK-12 docs 正直性
Wave 3 (P2):               TK-06 runtime-instructions / 儀式  ・ TK-07 output-contract  ・ TK-08 動的並列
Wave 4 (P3):               TK-09 facet pack  ・ TK-10 OTel  ・ TK-11 facet eval
```

各 Wave は「1 変更 1 検証」、ファイル所有分離、Wave 末にゲート(reviewer + `pnpm check:*`)。実装者 subagent + オーケストレータレビューの運用モードに従う。

## 6. 実装状況(2026-08-16)

| ID    | 状態            | 備考                                                                                         |
| ----- | --------------- | -------------------------------------------------------------------------------------------- |
| TK-01 | Wave 1 実装済み | `core:judge_route`、先頭一致・fail-closed、構造化判定、route journal/Trace、fixture テスト   |
| TK-02 | Wave 1 実装済み | route back-edge lint、既定 hop 上限(steps×3)、同一/周期 route cycle 検出                     |
| TK-03 | Wave 1 実装済み | `core:await_decision`、approval-store、`run_suspended` journal、プロセス跨ぎ `--resume`      |
| TK-04 | Wave 2 実装済み | `facet-registry`、pipeline/context-packのfacet合成、tenant tier deny、純度check              |
| TK-05 | Wave 2 実装済み | step/provider/profile/model/permission/promotion routing、route provenance、profile dispatch |
| TK-06 | Wave 3 実装済み | runtime-instructions hook、Claude/AGY生成物、drift check                                     |
| TK-07 | Wave 3 実装済み | perform後report、複数reportのorder、schema検証、report span                                  |
| TK-08 | Wave 3 実装済み | `items_from.pool_ref`、fixture selection、`core:team_lead`、max_concurrency≤3                |
| TK-09 | Wave 4 実装済み | approved managed pluginのmanifest宣言facetを解決                                             |
| TK-10 | Wave 4 実装済み | opt-in OTLP/HTTP exporter、既存Trace形式は維持                                               |
| TK-11 | Wave 4 実装済み | `eval/facets/`のdeterministic content contract評価                                           |
| TK-12 | Wave 2 実装済み | `EXTENSION_POINTS.md` / `pipelines/README.md` とschema/checkの整合                           |

### Wave 1 実装証跡 (2026-08-16)

- ADF schema に `judge_route` / `await_decision` の宣言契約を追加し、guardrail で未定義ターゲット・不正な hop 上限・意図しない `continue` を検出する。
- `executeGraph` は judge 出力 channel を `when` edge として扱い、ADF engine は `COMPLETE` terminal と suspend control flow をプロセス境界まで伝播する。
- `pipeline-run-journal` は `run_suspended` と再開時の suspension 消去を永続化する。承認要求の正本は既存 approval-store のままで、run journal は再開に必要な参照だけを保持する。
- 検証: `pnpm exec vitest run scripts/run_pipeline.test.ts libs/core/graph-scheduler.test.ts libs/core/adf-guardrails.test.ts libs/core/pipeline-run-journal.test.ts`、`pnpm run typecheck`、`pnpm lint`。

### Wave 2 実装証跡 (2026-08-16)

- `facets` は `knowledge/confidential/{tenant}/facets/` → `knowledge/product/facets/` → legacy role/builtin の順で解決する。public scopeからtenant facetを指定した場合や、未登録名を指定した場合は拒否する。
- pipeline step の `reasoning` は route profile と provider/modelを既存の `reasoning-route-policy` に投影し、`route_profile` と provider権限用 `profile` を分離して実行時に渡す。`reasoning.route_selected` Trace eventに選択層を記録する。
- context packは明示されたfacetだけを含め、同じtenant/tier boundaryで検証する。facet purityは `pnpm run check:facet-purity` をvalidateへ組み込んだ。
- 検証: `pnpm exec vitest run libs/core/facet-registry.test.ts libs/core/reasoning-route-resolver.test.ts libs/core/mission-context-pack.test.ts scripts/run_pipeline.test.ts`、`pnpm run typecheck`、`pnpm lint`、`pnpm run validate` (exit 0)。

### TK-08 実装証跡 (2026-08-16)

- `core:parallel_foreach` は既知の `items` に加えて、実行時contextの `items_from.pool_ref` と選択fixtureを受け付ける。選択結果は入力順を保持し、既存のmerge policyとbounded parallelismを再利用する。
- `core:team_lead` は `fixture_tasks` または構造化 `decomposeIntoTasks` 結果をworkerへ流し、`max_concurrency` を3以下へ強制する。guardrailでも3超を拒否する。
- 検証: `pnpm exec vitest run scripts/run_pipeline.test.ts libs/core/adf-guardrails.test.ts`、`pnpm run typecheck`、`pnpm lint`。

### Wave 3/4 実装証跡 (2026-08-16)

- TK-06: `ReasoningBackend.getRuntimeInstructions()` とprovider選択hookを追加し、reasoning prompt/delegation promptへworking principlesの後段としてprovider runtime instructionsを合成した。生成儀式はClaude/AGYの既存射影をSSoTから再生成し、`check:subagent-definitions`でdriftを検出する。Gemini/Codexのprovider stateを手書き生成物として追加せず、未設定providerはfail-closedのruntime noteを返す。
- TK-07: stepの`report`(単体または配列)を追加し、perform完了後にread-only report phaseを実行する。reportは登録structured contractまたは`knowledge/product/schemas/`配下のJSON Schemaで検証し、失敗は通常のrepair/error経路へ渡す。`use_judge`、`order`、`export_as`をtraceへ記録する。
- TK-09: managed plugin manifestの`facets`宣言を読み、`activationStatus=activatable`のmanaged packだけをproduct facetの後段で解決する。未承認・未宣言・pack外パスは解決対象外または拒否する。
- TK-10: `OTEL_EXPORTER_OTLP_ENDPOINT`が設定された場合のみ既存TraceをOTLP/HTTP JSONへ投影する。ローカルJSONL Traceが正本で、OTLP失敗はpipeline結果を変更しない。endpointは既存egress policyを通す。
- TK-11: `eval/facets/`のfixtureを用いたdeterministic content contract評価を`pnpm eval:facets`として追加した。engine mockテストとは独立し、CI必須ではない。
- 追加レビュー修正: tenant facet解決をauthorized payload/identity scopeに束縛、linear pipelineのjudge back-edgeをfail-closed、resume journalにroute control stateを保存、await timeoutのdeny/escalateを実装した。

## 7. 検証コマンド(実装時)

```bash
pnpm pipeline --input pipelines/baseline-check.json
pnpm run pipeline:dry-run -- --input <対象 pipeline>
pnpm check:op-registry
pnpm check:subagent-definitions
pnpm vitest run libs/core/graph-scheduler libs/core/adf-guardrails libs/core/reasoning-backend
```

## 8. 関連

- clean-room ノート: [takt-clean-room-notes](../../../knowledge/product/orchestration/takt-clean-room-notes.md)
- [GRAPH_ORCHESTRATION_PLAN_2026-07-28](../improvement-plans-2026-07/GRAPH_ORCHESTRATION_PLAN_2026-07-28.ja.md) / [LAYERED_EXECUTION_PLAN_2026-07-15](../improvement-plans-2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md) / [QM_ADOPTION_PLAN_2026-08-01](./QM_ADOPTION_PLAN_2026-08-01.ja.md) / [MISSION_GATE_COHERENCE_PLAN_2026-08-10](./MISSION_GATE_COHERENCE_PLAN_2026-08-10.ja.md)
