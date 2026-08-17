---
title: DeepSeek Harness 分析・採択計画(DH-01〜16)— 「すべて plugin」の筋と adapter パターンとの接続
tags:
  [
    deepseek-harness,
    dsh,
    cordis,
    plugin-architecture,
    capability-seam,
    adapter-pattern,
    waterfall,
    invariants,
    extension-model,
    adoption-plan,
  ]
last_updated: 2026-08-17
status: in_progress
---

# DeepSeek Harness 分析・採択計画(DH-01〜16)

> **作成日**: 2026-08-17
> **分析対象**: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)@ `47f94385`(2026-08-13、developer preview、219 workspace packages。clone: `active/shared/tmp/deepseek-harness`、分析後に削除可)
> **位置づけ**: QM / CLAW_EMPIRE / CLOUDFLARE_OS / TAKT / PI 採択計画と同型。ただし本計画の中心は個別機能ではなく **「すべてを plugin で実装する」というアーキテクチャ選択がどの程度スジが良いか、plugin 動詞の組み合わせをどう実現しているか、kyberion の adapter + registry パターンとどう比較され、plugin インターフェースをどう結びつけるべきか** の 4 問に答えること(§2〜§4)。改善項目(§5)はその結論から導く。
> **前提**: Cordis(vendored DI/plugin framework)を kyberion に持ち込まない。`libs/core` を 200 パッケージへ分割しない。kyberion の adapter seam・op registry・plugin provenance gate・tenant scope・drift checker はそのまま土台にし、dsh から **契約(seam 三役・可逆登録・waterfall・不変条件・生成グラフ)** を移植する。

## 1. dsh とは何か(要約)

dsh は DeepSeek の OSS エージェント harness(MIT、Node/pnpm、Web UI + headless + ACP + Python SDK)。README 冒頭で「**everything is a plugin**, powered by Cordis」と宣言し、`docs/architecture.md:11-13` は「model adapter、tool registry、session log、agent loop 自体も plugin で、**すべて設定から置換可能。patch すべき特権 core は無い**」とする。設計思想は `.agents/notes/`(proposed / implemented / rejected の Agent Note 台帳)と `docs/postmortem/` に率直に記録されており、我々の評価はそれらの一次資料に基づく。

### 1.1 「plugin」とは何か、plugin 動詞の一覧

plugin = `inject`(依存 service 名)と `apply(ctx)` を持つ関数、または `Service` サブクラス(`docs/cordis-primer.md:9`)。**すべての貢献は `ctx.effect()` / `ctx.on()` を通る可逆な効果**で、registry の `register()` は必ず disposer を返す(`AGENTS.md:102`)。plugin が取れる「動詞」は次の通り(実コードから網羅):

| 動詞                    | 呼び出し                                                                  | 例                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| service を提供する      | `super(ctx,'key')` / `ctx.plugin(Svc)`                                    | 48 の `ctx.*` キー(`ctx.tools`/`ctx.llm`/`ctx.sessions`/`ctx.fs`/`ctx.shell`/`ctx.sandbox`/`ctx.subagents`…) |
| service を消費する      | `export const inject=['tools']` / 任意は `ctx.get('sessionPersistence')`  | 依存は **起動順ではなく service 可用性**で解決(消えたら依存側も unload、戻れば reload)                       |
| 監視・介入する          | `ctx.on(event, listener, {prepend?, global?})`                            | `agent/pre-step`, `tools/pre-execute`, `fs/write-intent`, `approval/request`                                 |
| 型付き event を宣言する | `declare module` + `@mode` JSDoc(`emit\|waterfall\|parallel\|serial`)     | 生成カタログが宣言と dispatch 箇所を突合                                                                     |
| tool を登録 / mask する | `ctx.tools.register(defineTool)`, `.restrict(filter)`, `.presentAs(mode)` | 登録は scope 別 layer に落ちる                                                                               |
| **単調な拒否 guard**    | `ctx.tools.guard(g)` — 後段 waterfall が再許可できない                    | owner policy(並べ替え不可)                                                                                   |
| prompt section / 変数   | `ctx.systemPrompt.section()`                                              | 順序は `order` + canonical toolOrder                                                                         |
| 人間コマンド            | `ctx.commands` — model turn を作らず実行                                  | `/` コマンド                                                                                                 |
| 耐久 session event      | `SessionEventMap` を merge 拡張、log から render                          | 「**model-visible ⟺ logged**」                                                                               |
| projection unit         | `ctx.sessionProjections`(pure `init/apply/view`)                          | UI/一覧は fold 済み値を受ける                                                                                |
| background job          | `ctx.jobs.register()`                                                     | `job_list/output/kill` tool                                                                                  |
| **runtime invariant**   | `ctx.invariants.register(pkgName, installer)`                             | 失敗は `invariant violated by "<pkg>"`                                                                       |
| config schema           | schemastery `Config`(load 時検証)                                         | 「ハードコードされた tunable 禁止」                                                                          |
| UI node / RPC 型        | `ConversationNodeDefinition`, `ctx.typert.register`                       | Web/RPC                                                                                                      |
| 任意リソース            | `ctx.effect(() => …; return dispose)`                                     | timer, watcher                                                                                               |

### 1.2 動詞の組み合わせ方(composition)

- **依存で並ぶ、順序で並ばない**: `packages/bundle/base/cordis.patch.yml:14-15`「Row order carries no load semantics(activation is service-availability driven)」。boot は `assertEntriesLoaded/assertEntriesActivated` が PENDING(依存未解決)を列挙して落とす。
- **waterfall = around-middleware**: listener は `(...args, next)`、`next()` で委譲・呼ばずに短絡。「単一決定 event では短絡が設計」(`cordis-primer.md:30`)。`prepend:true` は invariant plugin と spill policy にほぼ限定。
- **policy は provider と consumer のどちらも import せずに間に入る**: `dsh-tool-fs` が `fs/write-intent` を emit し `dsh-fs-observation-policy` が決める。「emitter と policy が語彙だけ共有し依存しない」(`packages/fs/fs/README.md`)。`tools/pre-execute`, `approval/request`, `llm/stream` も同型。
- **seam 三役**(`AGENTS.md:109`): Service Definition / Service Provider / Consumer は「**完全な三役でひとつ。単独では seam ではない**」。しかも設計ノートは「これは Cordis の inject が答える『誰が提供し誰が要るか』とは別物で、**パッケージ境界の規律**」と明記(`.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`)。
- **多重度は seam ごとに宣言し、last-wins は使わない**: `ctx.shell`/`ctx.fs`/`ctx.sessionTitle`/`ctx.compaction` は **sole provider(2 個目の登録で throw)**、`ctx.subagents`/`ctx.llm`/`ctx.web`/`ctx.storage` は **名前付き多重 registry(重複名 throw)**。`ctx.web` は複数使用可能で id 未指定なら **`WEB_PROVIDER_AMBIGUOUS` で失敗**し、「Cordis load order・config order・HMR timing は product semantics ではない」(`2026-06-24-web-capability-seam.md:115`)。並行 load 前提のため consumer は `provider-added/-removed` event で反応する。
- **per-agent scope**(`packages/core/scope`、library で service ではない): scope key は親子 chain を成し「registration view は下へ継承、event admission は上へ拡張」、tool 名は most-specific-wins で shadow。**agent preset**(`ctx.agentPresets.mount`)は 1 プロセス 1 回 mount し、session は scope key を preset の下に parent させて参加。preset が service を提供するには `isolate` realm 必須(無ければ root realm に漏れるので mount 時に拒否)。
- **boot 合成**: profile → bundle 群(順序あり)→ profile `cordis.patch.yml` → home patch → `--patch`。patch は **id を指す行の config を丸ごと置換 / insert**(merge しない — 制限として明記)。`--dump-config` は boot と同じ parser/patch 算法で合成結果を出す。HMR は user patch layer を watch し「壊れた候補は last good tree を残す」。
- **model による runtime plugin mount**(`tool-cordis`: `cordis_inspect/define/run/stop/undefine`): define は構文検査のみ、client half は人の許可待ち、registry は process memory のみ、log は metadata だけ、「dynamic package は bash access と同等に扱え」。

## 2. 「すべて plugin」はどの程度スジが良いか(評価)

**結論: 拡張性の 8 割は Cordis の機構ではなく、その上に発明され機械化された規律から来ている。Cordis 自体は「依存駆動 activation」「可逆 effect」「5 種 dispatch mode(特に waterfall)」「isolate realm」の 4 点を提供し、それは価値があるが無料ではない。**

根拠(dsh 自身の記録):

| 観点                                 | 事実                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| framework 起因の重大障害             | postmortem 0001: `export default apply` 1 行で Loader の `unwrapExports` が `.default` を優先し `inject/name/Config` を捨て、**100% coverage で完全に動かない ACP**。同件 bug 2: 任意 service の `ctx.<name>` 直読みが shadow fiber 境界で throw → 「任意 service は `ctx.get()`」規則化。postmortem 0002: `!!js` が `disabled` フィールドで truthy な式オブジェクトに評価され、**FS スタック全体が恒久無効化**、snapshot suite は `UNKNOWN_TOOL` を期待値として記録し続けた |
| 「順序は意味ではない」の破れ         | prompt section 同 `order` の tie-break は登録順(=「plugin-load artifact」)、`fs/*` 決定 slot は「登録順 first-wins、default-deployment convention であって event 強制の不変条件ではない」、`timeout-policy` は「登録順が意味を選ぶ」。approval `never` は「listener 形の gate では約束を守れない」ため **service 本体で dispatch 前に判定**(= plugin ではなく core が決める)                                                                                                 |
| scope は機構ではなく規約             | 「scope-aware API だけが状態を隔離する。任意の Cordis service は scoped ctx 経由で呼んでも context-global のまま」「scope は sandbox でも authority 境界でもない」(`packages/core/scope/README.md:35`)                                                                                                                                                                                                                                                                       |
| 特権 core の再出現(文書化されている) | (1) `agent-loop` は唯一の driver で seam 分類上 `bundle`、変更時 `docs/architecture.md` 更新必須。(2) 「model-visible ⟺ logged」は全 plugin が従う **global 制約**で runtime invariant が強制。(3) host plane / agent plane: preset は registry・sandbox/approval・persistence・model route を持てない(mount 時拒否)。(4) fork children の one-shot 制約は「3 つの設定ファイルとコメントに住み、gate は無い」と自認                                                          |
| コスト                               | seam 三役で「packages と boilerplate(package.json/tsconfig/README/invariant companion/injection 配線)が増える」「1 backend しか無い段階から前倒しで発生」。結果 219 packages、~35 の `verify-*` doc gate、Agent Note 必須、「product-visible plugin は hand-mount テストでは不十分、実合成テスト必須」、per-file 100% coverage、preset 世代は回収されずプロセス終了まで残る                                                                                                  |

つまり dsh が示しているのは「DI/plugin framework を入れれば拡張性が出る」ではなく、**(a) seam の三役を揃える、(b) 登録は必ず取り消せる、(c) 順序を意味にしない(曖昧なら失敗)、(d) 方針は provider/consumer を import しない event 語彙で間に入る、(e) 宣言と配線と文書を生成物+fail-closed checker で突合する** — の 5 規律が効いているということ。これらは **plain な adapter interface + registry でも実現できる**。移植できないのは「依存駆動の PENDING/reload」「isolate realm」「id 指定 patch 層による設定合成(→ dump-config)」の 3 点で、これらは kyberion で必要になった箇所にだけ局所実装すればよい。

## 3. kyberion の adapter パターンとの比較

kyberion 側の実態(実コード突合、`libs/core` 1,813 非テスト .ts / `index.ts` 2,582 行・約 1,250 export / actuator 32 / `check:*` 48):

| 軸                         | dsh                                                                                                                   | kyberion(現状)                                                                                                                                                                                                                                                                                                        | 差分の性質                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| seam の形                  | Definition/Provider/Consumer 三役をパッケージ境界で強制                                                               | `interface + N impl + register<X>()/get<X>()` が **27 seam**(`registerAgentExecutionPort`, `registerSurfaceProvider`, `registerEmbeddingBackend`, `registerVoiceBridge`, `registerDeploymentAdapter`, `registerSecretResolver`…)、`adapter-first-extension-policy.md` に 4 層規則。**機能的には同等、container 無し** | 同等                              |
| provider の選択            | seam ごとに sole / 名前付き多重を宣言、曖昧は `*_AMBIGUOUS` で失敗、last-wins 無し                                    | reasoning は policy JSON(`tenant/organization/project_overrides`)+ 能力 filter で選択(強い)。**27 の register/get seam は last-write-wins**、`adapter-default-preferences.ts` は module 変数を mutate                                                                                                                 | kyberion 劣後(reasoning 以外)     |
| 可逆登録                   | 全登録が disposer を返す(`ctx.effect`)                                                                                | **`unregister*` は 0 件**、テスト差し替えは「singleton を mutate → `reset*()`」で **116 個の `reset<Thing>()`**                                                                                                                                                                                                       | 劣後                              |
| 依存順序                   | `inject` による可用性駆動 activation、boot audit が PENDING を列挙                                                    | `_installReasoningBackendsCore` に「order matters: voice bridge runs after reasoning backend」(`reasoning-bootstrap.ts:906`)とコメントで手動順序                                                                                                                                                                      | 劣後                              |
| provider 集合の開放性      | model adapter も plugin(`ctx.llm.registerAdapter`)                                                                    | `buildReasoningRuntimeBundle` は **20 分岐 switch**(`reasoning-bootstrap.ts:283-620`)、全 vendor SDK を core が import。新 provider = core 編集(adapter-first policy §3「呼び手変更なし」の約束と矛盾)                                                                                                                | 劣後                              |
| op / tool の解決           | `ctx.tools.register` — plugin が tool を足せる                                                                        | `namespace:op` は **ファイル規約**(`dist/libs/actuators/<id>/src/index.js`、`path-resolver.ts:190`)で動的 import。op registry は validator であって resolver ではない。plugin は op を足せない                                                                                                                        | 劣後                              |
| plugin が貢献できるもの    | §1.1 の全動詞                                                                                                         | skill plugin は `beforeSkill/afterSkill` の 2 hook のみ(`skill-plugin-loader.ts:46`)。承認後は full 権限で in-process import                                                                                                                                                                                          | 劣後(だが provenance gate は強い) |
| 方針の介入位置             | `tools/pre-execute → 単調 guard → execute → post-execute` の waterfall、approval `never` は service 内で pre-dispatch | tier guard は `secure-io` 内の真の interception。**approval は約 42 モジュールが call-site で呼ぶ**、egress は provider 境界で明示呼び出し。`LifecycleHookEngine`(13 event)は **並列実行 → boolean block**、値を順に変換する waterfall は無い                                                                         | 劣後(承認・egress)                |
| per-worker 能力合成        | scope key chain + preset(runtime)                                                                                     | `subagent-capability-profiles.ts` → `generate_subagent_definitions.ts` で **生成・コミット**(runtime 合成なし)。真の per-scope registry は `getMissionDynamicInjectionRegistry(missionId)` のみ。ADF `facets:` は宣言的(TK-04)で preset に相当                                                                        | 部分的                            |
| 「今どう束縛されているか」 | `--dump-config`(boot と同一算法)                                                                                      | 無し。`config:report` は env metadata のみ。reasoning だけ `reasoning_runtime_selection` audit 記録                                                                                                                                                                                                                   | 劣後                              |
| 宣言と実装の突合           | ~35 `verify-*` gate、独立 AST backstop、package-attributed invariants、生成 capability graph                          | **48 `check:*`**(43 が `validate`): generate-and-diff SSoT(`check:op-registry`, `check:subagent-definitions`, `check:env-registry`)、**dead-declaration 検出**(`check:event-wiring`「宣言だけの機能は不在より悪い」)、boundary allowlist ceremony(`kyberion-development-practices.md:16-28`)                          | **kyberion 同等〜優位**           |
| 実行前 provenance          | 無し(dynamic package は「bash access と同等」)                                                                        | plugin は承認済み path 以外 **import しない**(fail-closed execution)                                                                                                                                                                                                                                                  | **kyberion 優位**                 |
| tenant/scope 次元          | 無し(scope は agent 単位、authority 境界ではない)                                                                     | 選択(`tenant_overrides`)と event 可視性(`EventScope`)が tenant/org/project で統治                                                                                                                                                                                                                                     | **kyberion 優位**                 |
| 劣化の可視化               | invariants                                                                                                            | stub-taint(`recordStubServed`)、hollow-chain 検出、failover 時 `resetSession`                                                                                                                                                                                                                                         | 同等〜優位                        |

**要約**: kyberion は plugin framework の **seam は持ち、governance は上回るが、container(登録の可逆性・依存順序・scope 付き合成・束縛の可視化)を持たない**。拡張は「core の switch/singleton を編集 + JSON descriptor」で、正しさは 48 の checker が**事後に**保証する。dsh はそれを **runtime が読める依存グラフ**として持つ。両者は排他ではなく、kyberion に足すべきは container そのものではなく §2 の 5 規律の機械化と、必要箇所に限った局所 container(reasoning provider registry・op resolver・per-worker scope)である。

## 4. plugin インターフェースを adapter seam にどう結びつけるか(設計判断)

### 4.1 既存の `register<X>()/get<X>()` を「seam 契約」に昇格させ、plugin manifest はその seam に対して provider を宣言する

kyberion の 27 seam を `libs/core/seams/*.ts` に **`defineSeam({key, multiplicity: 'sole'|'named', select})`** で宣言し直し、`register()` は disposer を返す・sole は 2 個目で throw・named は重複名で throw・選択が曖昧なら `SEAM_PROVIDER_AMBIGUOUS` を返す。plugin(managed pack)は manifest に `provides: [{seam:'reasoning-backend', id:'my-vendor'}]` / `hooks: [...]` を宣言し、既存の provenance gate を通過した後にだけ **seam registry へ登録される**。dsh の「三役」は kyberion では「capability contract(型)/ adapter contract(impl)/ descriptor(JSON)/ registry+resolver」の 4 層規則(`adapter-first-extension-policy.md`)として既にあるので、そこに **可逆性・多重度・曖昧性** の 3 契約を足すだけでよい。

### 4.2 方針は「call-site 呼び出し」から「op preflight の waterfall」へ

`tools/pre-execute → monotonic guard → execute → post-execute` を kyberion の **op dispatch(`run_pipeline`/actuator dispatch/`delegateTask`)の単一 preflight chain** として実装し、approval・egress・tier・adf-guardrails・spend-guard・KS scope gate を **その chain の listener** に移す(PI-08 の `{decision, reason, repaired_input, terminate}` と統合)。owner policy(tenant 隔離・`never` 承認)は **単調 guard**(後段が再許可不可)または service 内 pre-dispatch に置き、並べ替えで無効化できないようにする。`LifecycleHookEngine` は「観測・block」用途に残し、値変換は waterfall へ。

### 4.3 順序を意味にしない

seam 選択・prompt section・guard・hook のいずれも「登録順で決まる」経路を残さない。同順位は canonical order(JSON)で決め、それでも決まらなければ失敗する。並行 load を前提に consumer は `provider-added/-removed` を購読する。

### 4.4 局所 container は 3 か所だけ

(1) reasoning provider registry(switch → descriptor + provider module、plugin から追加可)、(2) op resolver(registry が実装を解決、plugin が `namespace:op` を寄与可、provenance 付き)、(3) per-worker scoped registry(`getMissionDynamicInjectionRegistry` を一般化した scope key chain)。それ以外に DI を持ち込まない。

### 4.5 宣言・配線・文書は生成物 + fail-closed で突合し、束縛は dump できる

`gen:capability-seams`(seam ごとの Definition/Provider/Consumer グラフ、完全性 guard)、`check:seam-multiplicity`、`invariants` registry(module 名で帰属、空は「No runtime invariant:」で説明必須)、`pnpm bindings --dump`(seam × 束縛 impl × 理由: policy/env/tenant/probe)。既存の generate-and-diff / dead-declaration checker と同じ流儀で。

## 5. 改善項目一覧

| ID    | タイトル                                                                                                               | 優先度 | 規模 | 対応する既存計画 / 基盤                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------ | ---- | ------------------------------------------------------------------------------ |
| DH-01 | op preflight の waterfall 化(approval/egress/guardrails/scope を call-site から interception へ、単調 guard)           | **P0** | M    | PI-08 / `enforceApprovalGate` / `provider-egress-gate` / `adf-guardrails` / KS |
| DH-02 | seam 契約 `defineSeam`(可逆登録・多重度宣言・曖昧は失敗)と 27 seam の移行                                              | **P0** | M    | `adapter-first-extension-policy.md` / 116 `reset*`                             |
| DH-03 | `pnpm bindings --dump`(seam × 束縛 × 理由)と `check:seam-multiplicity`                                                 | P1     | S    | KO-06 `pnpm scope` / `reasoning_runtime_selection` audit                       |
| DH-04 | reasoning provider を descriptor + provider module registry へ(20 分岐 switch の開放、plugin から追加可)               | P1     | L    | RG-01 / QM-06 / PI-10                                                          |
| DH-05 | op resolver 化(registry が実装を解決、managed pack が `namespace:op` を provenance 付きで寄与)                         | P1     | L    | `check:op-registry` / KD-06 plugin gate                                        |
| DH-06 | 「model-visible ⟺ logged」不変条件と module 帰属 invariants registry                                                   | P1     | M    | PI-05 record log / Trace v1 / `check:event-wiring`                             |
| DH-07 | 生成 capability-seams グラフ(三役の完全性 guard)と独立 AST backstop                                                    | P1     | S    | `CAPABILITIES_GUIDE` / `EXTENSION_POINTS.md` / `check:reference-drift`         |
| DH-08 | plugin manifest の貢献動詞拡張(`provides` seam provider / hooks / prompt section / facet)と skill-plugin-loader の統合 | P1     | M    | KD-06 / TK-04 facet / PI-09 provenance                                         |
| DH-09 | per-worker scoped registry(scope key chain、inherit-down / admit-up、most-specific-wins)                               | P2     | M    | `dynamic-injection.ts` / KO scope / TK-04                                      |
| DH-10 | pre-step admission chain(`agent/pre-step` reject\|enter)と inbox 二境界(followup/steer/非 wake inject)                 | P2     | M    | PI-15 3 キュー / SO-03 steering                                                |
| DH-11 | permission preset(独立 knob の束、`custom` は導出のみ)+ sandbox policy 単一 home と enforcement fact `full\|partial`   | P2     | S    | `provider-permission-profiles.ts` / PI-03                                      |
| DH-12 | continuable subagent(1 耐久 session・≤1 activation・inbox が唯一のキュー・cold resume)                                 | P2     | M    | PI-15/16 / `delegateTask`                                                      |
| DH-13 | credentials を参照(env 名)として保持し操作ごとに解決、`describe()` は値を出さない                                      | P2     | S    | `registerSecretResolver` / KO                                                  |
| DH-14 | 小物 guard: spill(0700/`wx` + opaque locator、best-effort)/ repeat-tool 助言 / `timeoutMs` を capability 定義に        | P2     | S    | `secure-io` / spend-guard / graph-scheduler                                    |
| DH-15 | 設計台帳の運用: Agent Note(proposed/implemented/**rejected**)と postmortem 形式の採用                                  | P3     | S    | improvement-plans / STATUS ledger                                              |
| DH-16 | 外部 hook 設定の互換 bridge(claude-code / codex hook 形式、deny > ask > allow)                                         | P3     | S    | `LifecycleHookEngine` / CT-01 生成儀式                                         |

---

### DH-01: op preflight の waterfall 化(P0 / M)

**dsh の設計**: `tool/call` を実行前に log → `tools/pre-execute`(allow/deny/ask、並べ替え可)→ **登録済み単調 guard**(deny-or-abstain、並べ替え不可、後段が再許可不可)→ `tools/execute`(around)→ 本体 → `tools/post-execute`(accept/block/replace/add context)→ 正規化 → 凍結 result(`docs/tool-execution-pipeline.md:6`)。approval `never` は service 内で dispatch 前に決める(`user-approval/src/index.ts:192`)。

**kyberion の現状**: tier guard は `secure-io` 内の interception だが、approval は約 42 モジュールが call-site で `requestApproval/requiresApproval` を呼び、egress は provider 境界で明示呼び出し。`LifecycleHookEngine` は並列 → boolean。新しい呼び出し経路ごとに gate を忘れる余地がある。

**実装**: `libs/core/op-preflight.ts` に `runOpPreflight(call, ctx)`(waterfall、`{decision: allow|block|ask, reason, repaired_input?, terminate?}`)、`registerOpGuard(g)`(単調 deny)。actuator dispatch・`run_pipeline`・`delegateTask`・MCP tool 実行の 4 入口を全て通す。approval / egress / scope / adf-guardrails / spend-guard を listener と guard へ移し、旧 call-site は段階的に削除、`check:op-preflight-coverage`(4 入口以外で gate 関数を直接呼ぶ箇所は allowlist 化して増加禁止)。受入: gate を 1 つも呼ばない新 actuator op でも tenant 隔離と approval が効く fixture、prepend した listener が `never` を覆せない。

### DH-02: seam 契約 `defineSeam`(P0 / M)

**dsh の設計**: 登録は disposer を返す effect、seam ごとに sole / 名前付き多重を宣言、曖昧は `*_AMBIGUOUS`、last-wins なし、consumer は `provider-added/-removed` に反応。

**実装**: `libs/core/seam.ts` に `defineSeam<T>({key, multiplicity, select?})` → `{register(id, impl, meta): Disposable, get(selector?): T | SeamAmbiguous, list(), on('added'|'removed')}`。27 の `register<X>/get<X>` を順次これに置換し、`reset*` はテストで `dispose()` に置換(段階的に 116 → 0)。`meta` は provenance(builtin / plugin id / tenant overlay)を持つ。受入: sole seam に 2 個目を登録すると throw、named seam で選択不能なら `SEAM_PROVIDER_AMBIGUOUS`、dispose 後に `get` が既定へ戻る。

### DH-03: `pnpm bindings --dump` と `check:seam-multiplicity`(P1 / S)

**dsh の設計**: `--dump-config` は boot と同じ算法で合成結果を出す。**実装**: 全 seam の `list()` と選択理由(policy JSON / env / tenant override / probe 結果 / 既定)を `--json` で出力し、KO-06 `pnpm scope` と並ぶ「今の束縛」の可視化に。checker は seam の宣言多重度と登録数・選択可能性を CI で検査。

### DH-04: reasoning provider の開放(P1 / L)

**dsh の設計**: model adapter は `ctx.llm.registerAdapter(providers[], adapter)`(route 排他、atomic replace)で plugin から追加。**kyberion**: `buildReasoningRuntimeBundle` の 20 分岐 switch。**実装**: `reasoning-provider-registry.json`(mode → module specifier + capability profile + env keys)+ provider module 契約(`createBackend(options)`)へ分解し、switch を registry lookup に。managed pack が provider を寄与できるようにし(DH-08)、`backend-conformance`(PI-13)で通過を義務化。RG-01/QM-06 の能力宣言と一体化。

### DH-05: op resolver 化(P1 / L)

**dsh の設計**: `ctx.tools.register` で plugin が tool を足し、registry が実行する。**kyberion**: `namespace:op` → ファイル規約 import、op registry は validator。**実装**: `actuator-op-registry.json` を resolver の SSoT にし(`domain → module, ops[]`)、builtin actuator はそのまま、managed pack は `provides.ops` を provenance 付きで登録。`check:op-registry` は生成・差分検査を維持しつつ「解決可能性」も検査。ADF 側の変更なし。

### DH-06: 「model-visible ⟺ logged」と invariants registry(P1 / M)

**dsh の設計**: model request に届くものは全て log から再構築可能、runtime invariant が強制。`ctx.invariants` は package 帰属で `invariant violated by "<pkg>"`、空は `No runtime invariant:` で理由必須(`verify-package-invariants`)。**実装**: `libs/core/invariants.ts`(module 名で登録、dev/test で有効、失敗は module 帰属メッセージ)、pack builder と dispatch に「prompt に入った断片は全て `mission-context-pack`/journal に記録済み」を assert(PI-05 と整合)。`check:module-invariants`(主要モジュールは invariant を持つか、空なら理由コメント)。

### DH-07: 生成 capability-seams グラフと AST backstop(P1 / S)

**実装**: `gen:capability-seams` が `defineSeam` 宣言・provider 登録・consumer import から `docs/developer/CAPABILITY_SEAMS.md`(mermaid)を生成、三役が揃わない seam は完全性 guard で失敗。独立 backstop(plain `ts` AST 走査)で「宣言された seam/event が文書に載る or 免除名がある」を fail-closed。既存 `check:reference-drift` に載せる。

### DH-08: plugin manifest の貢献動詞拡張(P1 / M)

**dsh の設計**: plugin は §1.1 の全動詞。**kyberion**: skill plugin は 2 hook。**実装**: managed pack manifest に `provides: {seams[], ops[], hooks[], prompt_sections[], facets[]}` を追加、provenance gate 通過後に seam registry / op resolver / hook engine / facet registry へ **可逆登録**(pack の deactivate で dispose)。restricted-skills / tenant_overrides の narrow-only(PI-09)と合成。受入: 未承認 pack は一切登録されない、deactivate 後に全貢献が消える。

### DH-09: per-worker scoped registry(P2 / M)

**dsh の設計**: scope key chain(inherit-down / admit-up、most-specific-wins)、preset は 1 回 mount で session が parent。**実装**: `getMissionDynamicInjectionRegistry` を一般化した `ScopedRegistry<T>`(tenant → org → project → mission → task → session の chain 上で shadow)を DH-02 の seam に任意で載せ、facet(TK-04)と subagent capability profile を runtime 合成へ寄せる(生成 `.claude/agents/*.md` は projection として維持)。

### DH-10: pre-step admission chain と inbox 二境界(P2 / M)

**dsh の設計**: `agent/pre-step` が「model が見るもの」を決める唯一の serial chain(reject | enter(messages))、inbox は next-turn / next-step の 2 境界、`inject()` は **非 wake**、`turn-stopping` は data(steer)で反対する。**実装**: worker loop に `pre_step` waterfall(圧縮圧力・pack 注入・guard)と `deliver_as: follow_up|steer|inject`(PI-15 の 3 キューと統合、inject は wake しない)。`whenIdle` は interval-wide と明記(defensive-patterns)。

### DH-11: permission preset と sandbox policy 単一 home(P2 / S)

**dsh の設計**: preset = `sandbox/mode` + `approval/policy` の束、`custom` は導出のみ、enforcement は各 knob が持ち preset は意図を記録するだけ。sandbox policy は 1 か所で解決し enforcement fact `full|partial` を報告。**実装**: `provider-permission-profiles`(readonly/edit/full)と approval policy を独立 knob とし、`permission-presets.json` で束ねる。`adf-guardrails`/`secure-io`/egress が別々に持つ sandbox 判定を `sandbox-policy.ts` に集約し、`partial` を受け入れられない呼び手は拒否できるようにする。第一段として provider-neutral resolver と `requireSandboxEnforcement` を追加し、Codex app-server adapter/CLI backend の request projection を同じ resolver に接続した。

### DH-12〜16(P2〜P3、S〜M)

- **DH-12** continuable subagent: `delegateTask` の one-shot に加え、耐久 child session + ≤1 activation + inbox 唯一キュー + cold resume(PI-15/16 と同じ worker runtime 変更でまとめる)。settled 通知は child の report と provenance を分ける。
- **DH-13** credentials as references: `registerSecretResolver` を「env 名参照 + 操作ごと解決」に固定し、`describe()` は `configured/writable` のみ。rotation が次 request に効く。
- **DH-14** 小物 guard: spill(`secure-io` に 0700/`wx` の spill 保存と opaque locator、失敗しても元 result 維持)、repeat-tool 助言(同一 (op, args) の反復に `[3,5,8]` で注意注入、denied も数える)、`timeoutMs` を op 定義側に(graph-scheduler は宣言を読む)。
- **DH-15** 設計台帳: `docs/developer/design-notes/{proposed,implemented,rejected}` と `docs/developer/postmortem/`(問題 → 例/trace → 解 → 予防規則)。**rejected の理由を残す**運用が dsh の最も安価で効く規律。
- **DH-16** 外部 hook 互換 bridge: claude-code / codex の hook 設定を `LifecycleHookEngine` で解釈(deny > ask > allow、sticky halt、drain-on-dispose)。CT-01 生成儀式の逆方向。

## 6. dsh から「思想として」持ち込むもの(コード変更を伴わない採択)

- **「seam は三役でひとつ」** — provider だけ・interface だけを足す PR を seam 追加と呼ばない。
- **「登録は効果、効果は取り消せる」** — `reset*` を増やす代わりに disposer を返す。
- **「順序は意味ではない」** — 登録順・設定順・並行 load タイミングで振る舞いが変わる箇所は欠陥として扱い、曖昧なら失敗する。
- **「model-visible ⟺ logged」** — prompt に入るものは全て log から再構築できる。
- **「policy は provider/consumer を import せず、語彙だけ共有して間に入る」**。
- **「owner policy は listener ではなく service 内 pre-dispatch か単調 guard」**(listener 形の gate は約束を守れない)。
- **「宣言だけの機能は不在より悪い」** — kyberion の `check:event-wiring` と同じ原則が dsh の独立 AST backstop にもある。両者を相互参照する。
- **「hand-mount テストは実合成の証拠ではない」** — product-visible な plugin/seam は boot 経路を通す実合成テストを持つ。
- **「rejected を記録する」**。
- **「async 状態は同期状態ではない」** — `whenIdle` は interval-wide、待てない遷移は明示的に扱う。

## 7. 非採用(理由付き)

| 項目                                                                                | 理由                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cordis(vendored DI/plugin framework)の導入                                          | dsh 自身の 2 大障害が framework 機構起因。kyberion は seam と governance を既に持ち、container の利点は 3 か所(DH-04/05/09)の局所実装で得られる                                                   |
| `libs/core` の 200+ パッケージ分割                                                  | dsh の seam ノートが「boilerplate 前倒し」「1 backend の段階から発生」と自認。kyberion は barrel を維持し、seam 契約と生成グラフで境界を可視化する(分割は別判断)                                  |
| model による runtime plugin mount(`tool-cordis`)                                    | 「bash access と同等」と dsh 自身が言う。kyberion の provenance gate(承認前 import 禁止)と矛盾。two-phase define/run + 人の許可 + 非永続の**設計**は、将来 ADF 動的 op を検討する際の参考に留める |
| model が書く workflow script を `vm` で実行(`packages/workflow`)                    | ADF DAG は宣言的で監査可能。「engine 側 policy(`maxTotalAgents`/provider override)を script から観測不能に」する思想のみ採る                                                                      |
| `SESSION_FORMAT_VERSION = 0`・旧形式拒否(「foundation over blast radius」)          | tenant と live mission を持つ kyberion は journal 形式の移行が必須                                                                                                                                |
| per-file 100% coverage、二言語生成 doc パイプライン(`.i18n.yaml` + ~35 verify gate) | 若い小パッケージ群には可、既存 platform では filler を生む。world-verification(自己申告でなく外界を再確認)の原則のみ採る                                                                          |
| `ctx.*` の平坦な名前空間、preset 世代の未回収                                       | dsh 自身が衝突監査と leak を認める箇所                                                                                                                                                            |

## 8. 実施形態

- **Wave 0(P0)**: DH-01(preflight waterfall)と DH-02(seam 契約)。どちらも既存 call-site/singleton の**置換**で、KS/KO/PI-08 の gate 統合を待たずに始められる。DH-02 の移行は seam ごとに独立(27 件を数 wave に分割)。
- **Wave 1(P1)**: DH-03(dump)→ DH-07(生成グラフ)→ DH-06(invariants)→ DH-08(manifest 動詞)→ DH-04 / DH-05(provider・op の開放、L)。DH-04/05 は PI-10/13(能力宣言・conformance)と同じ wave に置く。
- **Wave 2(P2)**: DH-09(scoped registry)→ DH-10/12(worker runtime: pre-step・inbox・continuable、PI-14/15/16 と同一変更)→ DH-11/13/14。
- **Wave 3(P3)**: DH-15/16。
- 実装は subagent 委譲 + orchestrator レビュー方式(ファイル所有分離、DH 単位 commit、wave ごと gate)。各 DH は「契約テスト → 実装 → checker/validate 緑 → 本文書の実装状況に証跡」で閉じる。
- 分析用 clone `active/shared/tmp/deepseek-harness` は確定後に削除可(参照は commit hash と path)。

## 9. 実装状況(2026-08-17)

- 2026-08-17: read-only 分析(3 経路: Cordis plugin 合成モデル・seam・boot 合成・runtime mount・型安全・自認コスト / runtime 意味論・不変条件・governance・multi-agent・永続・テスト / kyberion 側の拡張機構 12 軸の実コード突合)に基づき策定。kyberion 側の事実(27 register/get seam、`unregister*` 0 件、116 `reset*`、`buildReasoningRuntimeBundle` 20 分岐、`path-resolver.ts:190` のファイル規約 dispatch、skill plugin 2 hook、approval 約 42 call-site、`LifecycleHookEngine` 並列 boolean、48 `check:*`)は実コードで確認。
- 2026-08-17: DH-01 の共通契約 `libs/core/op-preflight.ts` と単調な approval guard を実装し、`run_pipeline` の leaf op 入口、MCP 共通入口、`DispatchingReasoningBackend.delegateTask`、service-actuator の直接実行入口へ接続。serial listener、修復入力、`allow|block|ask`、trace 記録、重複登録検査を `op-preflight.test.ts` と service-actuator テストで固定した。actuator 全体の共通接続と egress/scope/ADF/spend guard の専用 listener 化は未完了。
- 2026-08-17: DH-02 の `libs/core/seam.ts` (`sole` / `named`、disposer、曖昧選択拒否、added/removed event、provenance metadata)を実装し、embedding backend、intent extractor、voice bridge、secret resolver、actuator forwarding port、task plan coordinator、agent execution port、deployment adapter、speech-to-text bridge、streaming STT/TTS bridge、meeting join driver、audit forwarder、VAD backend、environment capability probe、surface provider、task intent builder、actuator capability probe、structured runner、email account provider、reasoning backend を移行した。bootstrapの再選択は旧providerを明示disposeしてから新chainを登録する。全 27 seam の移行と `reset*` の置換は未完了であり、移行ごとに独立検証する。
- 2026-08-17: DH-03 の runtime catalog (`coreSeamCatalog`) と `pnpm bindings --dump [--json]`、`check:seam-multiplicity` を追加し、移行済み 21 seam の多重度・provider id・provenance を決定的に出力・検査できるようにした。bindings dump の明示 import も surface/task-session/actuator capability/mission-llm/email account/reasoning backend まで揃え、未移行 seam は catalog へ追加されていないため、dump は全 27 seam の完了を意味しない。
- 2026-08-17: DH-01 をdelegate入口へ拡張し、`DispatchingReasoningBackend.delegateTask` が preflight の修復入力と拒否判定を通るようにした。さらに orchestrator の in-process actuator dispatch と、新規 actuator scaffold の direct dispatch も標準 waterfall を通し、直接 actuator 実行で approval/scope 等を迂回できない回帰テストを追加した。既存 actuator の CLI/embedded 直呼び出しや egress/scope/ADF/spend guard の全経路統合は未完了。
- 2026-08-17: DH-04 の第一段として `reasoning-provider-registry.json` と `libs/core/reasoning-provider-registry.ts` を追加し、20 mode の provider/module/capability/env descriptor を policy と突合する checker (`check:reasoning-provider-registry`) を導入した。bootstrap の provider identity と broker の mode 集合は registry lookup に移し、managed provider factory は同じ runtime bundle 契約で disposer 付き登録できる。新規 mode を policy/managed-pack から追加する manifest gate と、組み込み switch 全体の factory 分解は未完了。
- 2026-08-17: DH-04 の第二段として local / ollama / vllm / lmstudio / llamacpp / mlx / localai / nemotron-api の8 modeを `reasoning-openai-compatible-provider.ts` の provider moduleへ移し、bootstrap switch は module resolver を先に参照するようにした。registry checker は descriptor の module specifier が実在することも検査する。残りの CLI/API built-in factory 分解、新規 mode の managed-pack manifest gate、provider-specific conformance の必須化は未完了。
- 2026-08-17: DH-02 の追加 wave として VAD backend を `voice.vad-backend` named seam に移行した。既存の unknown/unavailable → energy fail-soft と reset API を維持しつつ、duplicate id を拒否し、disposer/provenance と bindings dump を追加した。
- 2026-08-17: DH-02 の追加 waveとして environment capability probe registry を `environment.capability-probe` named seam に移行した。probe の duplicate id を拒否し、既存の reset/manifest probe 挙動を disposer ベースで保持した。
- 2026-08-17: DH-01 の既定 waterfall を `op-preflight-defaults.ts` として追加し、scope（protected tier の tenant binding）、ADF guardrails、provider egress、reasoning spend を標準 listener/guard に接続した。pipeline / service-actuator / delegateTask / MCP / orchestrator in-process dispatch の5公開入口が毎回 `ensureDefaultOpPreflight()` を呼び、`check:op-preflight-coverage` が接続の後退を検出する。個別 gate の全置換と詳細 approval/egress metadata の全 actuator への展開は未完了。
- 2026-08-17: DH-01 の追加段として共有 `executeAdfSteps` を標準 preflight 境界にし、ADF を利用する actuator の capture/transform/apply step が `scope → ADF → egress → spend` waterfall を通るようにした。listener の `repaired_input` は handler に渡し、`block|ask` は `on_error` fallback で迂回できない terminal admission とした。非 ADF の個別 handleAction、approval metadata の全 actuator 展開は未完了。
- 2026-08-17: DH-01 の追加段として terminal actuator の direct action (`spawn/poll/write/kill/resize/llm_decide`) も `terminal:<action>` preflight を通すようにした。computer-interaction は内部の typed action に収束して二重の自由経路を作らず、既存の PTY contract tests を維持した。browser/vision/その他の非 ADF direct action と approval metadata の全 actuator 展開は未完了。
- 2026-08-17: DH-01 の追加段として vision actuator の perception/legacy direct action も `vision:<action>` preflight を通すようにした。pipeline からの各 step も同じ境界を通るため、direct と pipeline で governance を分けない。その他の非 ADF direct action と approval metadata の全 actuator 展開は未完了。
- 2026-08-17: DH-01 の追加段として process / secret / deployment / email actuator の direct または actuator-owned pipeline 境界にも `ensureDefaultOpPreflight()` と `runOpPreflight()` を接続した。修復済み入力を実処理へ渡し、`check:op-preflight-coverage` の対象を8から12境界へ拡張した。agent / approval / meeting / network などの残る非 ADF direct path、approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として agent / approval / meeting actuator の direct action も標準 preflight を通すようにした。agent の pipeline dispatch は最終 action の境界で検査し、meeting は provider の自動解決後に修復済み params を bridge へ渡す。`check:op-preflight-coverage` は12から15境界へ拡張し、network は既に共有 ADF engine 経由である。browser など残る非 ADF direct path、approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として voice actuator の exported `handleSingleAction` を含む direct/pipeline action にも標準 preflight を接続した。validate 済み action に対する修復入力を実行分岐へ反映し、`check:op-preflight-coverage` は15から16境界へ拡張した。さらに custom pipeline loop を持つ android/ios の各 step も修復済み params を実行へ渡すようにした。browser/computer-interaction、approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として browser の `computer_interaction` 公開境界にも `browser:computer_interaction:<type>` preflight を接続した。直接 helper へ渡す前に scope/ADF/egress/spend の標準 waterfall と repaired input を適用し、`check:op-preflight-coverage` は18から19境界へ拡張した。approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として build / blockchain / calendar / presence / working-memory の direct handler も標準 preflight を通すようにした。validation 前後の repaired input、pipeline context、operation-specific namespace を保持し、`check:op-preflight-coverage` は19から24境界へ拡張した。media-generation / video-composition / modeling など残る direct/custom loop、approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として media-generation / video-composition の direct action を preflight 化した。video の cancellation は event-loop 前に開始される既存契約を保つため、同期 listener/guard のみを許可する `runOpPreflightSync` を追加し、async extension は fail-closed にした。`op-preflight.test.ts` と video cancellation fixture で検証し、modeling / ingest など残る direct/custom loop、approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として ingest の custom pipeline loop 各 op と modeling の `reconcile` entry にも preflight を接続した。ingest は context 変数解決後の repaired params を実処理へ渡し、`check:op-preflight-coverage` は26から28境界へ拡張した。orchestrator / media / その他の custom direct helper と approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-01 の追加段として legacy orchestrator pipeline helper の各 step にも標準 preflight を接続した。super-nerve と legacy helper の二重実装で governance が分かれないよう、control/capture/transform/apply の全分岐へ repaired params を渡し、`check:op-preflight-coverage` は28から29境界へ拡張した。media の ADF 外 direct helper と approval metadata の全 actuator 展開、個別 gate の全面置換は未完了。
- 2026-08-17: DH-07 の第一段として `generate:capability-seams` / `check:capability-seams` を追加し、移行済み 20 seam の declaration/provider/consumer 役割を `docs/developer/CAPABILITY_SEAMS.md` に決定的に生成する。宣言 module の `defineSeam`、consumer file の存在、runtime catalog との対応を fail-closed で検査する。独立 TypeScript AST backstop と未移行 seam の全27件化は未完了。
- 2026-08-17: DH-05 の第一段として `resolveActuatorOperation(domain, action)` を actuator op registry と manifest catalog に接続し、解決した actuator id・module path・step type・manifest path を返すようにした。module path は manifest の `entrypoint` を基準に `.js` へ決定的に変換する。`run_pipeline` は registry 解決を優先し、`actuator.resolved` trace に provenance を記録し、未登録の managed/legacy actuator だけ従来の filesystem convention にフォールバックする。managed pack の runtime op 登録と convention fallback の完全廃止は未完了。
- 2026-08-17: DH-05 の第二段として manifest entrypoint の module path 変換を `resolveActuatorModulePath` に分離し、absolute path と `.`/`..` segment を import 前に拒否する fail-closed 境界と fixture を追加した。managed pack の runtime op 自動発見、operation-level module catalog、convention fallback の完全廃止は未完了。
- 2026-08-17: DH-05 の第三段として plugin が寄与した `namespace:op` も `listRegisteredDomainOps` の domain catalog へ合成し、既存の registry consumer が builtin と managed op を同じ一覧で参照できるようにした。DH-14 の operation timeout も plugin API の宣言から resolver・`actuator.resolved` trace へ伝播する。managed pack の自動発見、operation-level catalog の永続化、convention fallback の完全廃止は未完了。
- 2026-08-17: DH-06 の第一段として module 帰属付き `libs/core/invariants.ts` を追加し、op-preflight / seam / lifecycle-hook-engine の runtime assert と reasoning-provider の PI-05 待ち documented invariant を登録した。`check:module-invariants` は主要4 module の登録と source assertion を fail-closed に検査する。model-visible 内容の durable log 再構築、全主要 module の invariant 接続、空 invariant の設計理由台帳は未完了。
- 2026-08-17: DH-08 の第一段として `plugin-contributions.ts` を追加し、承認済み plugin manifest の `provides` と実コード登録を突合する reversible activation を実装した。ops は actuator resolver、hooks/preflight は既存 engine、prompt sections/facets は provenance 付き registryへ接続し、未宣言・不完全 contribution は全 rollback する。`skill-plugin-loader` の公式 fixture で load→register→dispose を検証した。managed pack の tenant overlay/facet loader 全体との合成、plugin provider の conformance gate、外部 hook bridge は未完了。
- 2026-08-17: DH-04 の第三段として CLI/ACP 系 7 mode（`claude-cli` / `codex-cli` / `claude-agent` / `gemini-cli` / `agy-cli` / `grok-cli` / `copilot`）を `reasoning-cli-provider.ts` に抽出し、bootstrap は registry/module resolver を先に通すようにした。provider registry の `module` 宣言も CLI/OpenAI-compatible family の実装 module と突合する形へ更新し、35 件の provider/bootstrap テストと registry checker を通過した。新規 mode を manifest から追加する gate、provider-specific conformance の必須化、managed provider factory の全自動ロードは未完了。
- 2026-08-17: DH-04 の第四段として hosted API 系 4 mode（`anthropic` / `gemini-api` / `grok-api` / `openrouter`）を `reasoning-api-provider.ts` に抽出し、provider registry の module 宣言と実装 module の照合対象へ統一した。bootstrap の組み込み switch は registry → OpenAI-compatible → CLI → API provider module の順で解決する。新規 mode の manifest gate、provider-specific conformance の CI matrix、managed provider factory の自動発見は未完了。
- 2026-08-17: DH-04 の第五段として OpenAI-compatible backend に shared `ReasoningBackend.generateWithTools` を実装した。DeepSeek/Ollama/vLLM/LM Studio 等へ governed `ToolDefinition` を function-tool wire として渡し、tool call は実行せず worker/ADF 側へ返すため、local provider でも goal worker の同じ tool governance を利用できる。deferred native wire、provider-specific conformance の CI matrix、新規 mode manifest gate、managed provider factory の自動発見は未完了。
- 2026-08-17: DH-04/DH-08 の第二段として plugin manifest の `provides.providers` を `registerReasoningProvider` へ接続した。既存の governed mode のみ登録可能で、未宣言・未知 mode・activation failure は rollback され、dispose 後に factory が残らない。新規 mode の policy/catalog 拡張、provider-specific conformance の activation gate、managed pack の自動発見は未完了。
- 2026-08-17: DH-04/PI-13 の第三段として、non-stub の plugin provider 登録に versioned live conformance receipt（prompt / structured output / abort / usage の4 check）を必須化した。prompt / structured output / abort は `live:true` かつ `verified`、usage は adapter 境界の `declared` を許容する。offline の `unavailable` receipt は診断には使えるが activation authority にはならない。provider-specific live matrix の CI 自動実行と managed provider factory の自動発見は未完了。
- 2026-08-17: DH-14/PI-19 の第一段として ADF `system:shell` / `system:exec` に co-execution git guard を接続した。広域 reset/checkout/clean/stash、全体 add、no-verify commit、force push を preflight で拒否し、明示 path の通常 git 操作は許可する。approval-bound recovery surface と全 shell 経路への同一 guard 適用は未完了。
- 2026-08-17: DH-06 の第二段として `prompt-visibility-ledger` を追加し、task knowledge の `pack` / `system_prompt` / `context_string` レンダリング時に本文を保存せず hash・長さ・context pack/task/knowledge refs を mission-local JSONL へ記録するようにした。`prompt-visibility-ledger:record-shape` invariant と corruption code (`MISSION_LOG_CORRUPT:prompt_visibility_record`) を追加し、`provisionTaskKnowledge` が返す receipt から durable log を追跡できる。prompt fragment 全経路の記録と PI-05 journal との再構築統合は未完了。
- 2026-08-17: DH-06 の第三段として `mission-orchestration-worker` の初回 task dispatch / structured-result retry を A2A 送信前に `prompt-visibility-ledger` へ接続した。本文ではなく hash・長さ・task/context-pack/knowledge refs の receipt を先に書き、ledger 書込み失敗時は model 送信を止める。compaction summary、goal loop、best-of judge など別の model-visible 経路の統合は未完了。
- 2026-08-17: DH-09 の第一段として `ScopedRegistry<T>` と `ScopedDynamicInjectionRegistry` を追加した。tenant→organization→project→mission→task→session の ancestor 継承、最具体 scope の shadow、同深度の曖昧拒否、added/removed disposer、compaction reset を登録順に依存しない形で固定した。既存の mission-only registry は互換維持のため残し、worker 全経路の scope key 化は未完了。
- 2026-08-17: DH-09 の第二段として mission ごとの scoped injection registry を追加し、goal-driven worker に mission→task→session scope を渡せるようにした。mission ancestor の provider と task-specific provider が同じ turn prompt へ deterministic に合成され、goal status/objective provider も同じ scope で登録・解除される。single-shot worker と他の dynamic injection caller の全面 scope 化は未完了。
- 2026-08-17: DH-06 の第四段として goal-driven worker の各 turn と budget grace step に `onPromptVisible` callback を追加し、mission worker が実際の model-visible prompt を A2A dispatch と同じ metadata-only ledger へ記録するようにした。goal loop の direct caller は callback 任意で後方互換を維持し、scope/context-pack/knowledge refs も receipt に引き継ぐ。compaction summary と best-of judge の独立 prompt 経路は未完了。
- 2026-08-17: DH-06 の第五段として dispatch context compaction summary と best-of judge の prompt も ledger 記録対象に追加した。single-shot、retry、goal turn/grace、compaction、judge の主要 mission worker 経路は送信直前に receipt を作る。一般の `ReasoningBackend.prompt/generateWithTools` 呼び出し、PI-05 journal との再構築は未完了。
- 2026-08-17: DH-06 の第六段として `ReasoningCallOptions.prompt_visibility` を追加し、一般の `ReasoningBackend.prompt` / `generateWithTools` / `streamPrompt` / `promptWithImages` / `delegateTask` が mission context を明示した場合に provider 呼び出し前の metadata-only receipt を作るようにした。ledger 失敗時は provider を呼ばず、prompt/tool/image 定義本文は保存しない。全 direct caller への自動 context 供給と PI-05 journal 再構築は未完了。
- 2026-08-17: DH-02 の公開契約整合段として、移行済み seam の `.d.ts` に disposer (`() => void`) の戻り値を反映した。実装側だけが可逆登録を返し、パッケージ利用者の型からは `void` に見える不一致を解消した。未移行の登録経路、全27 seam の catalog 化、`reset*` の全面置換は未完了。
- 2026-08-17: DH-07 の第二段として `check:capability-seams-ast` を追加した。生成器の hand-maintained role map とは独立に TypeScript AST から production `defineSeam` 宣言を収集し、重複 key・catalog 未登録・生成 graph 未掲載を fail-closed で検査して CI に接続する。未移行 seam の定義/consumer 自動発見と全27 seam 化は未完了。
- 2026-08-17: DH-08 の第二段として plugin の `provides.seams` を実際の `coreSeamCatalog` に合成する boundary test を追加した。provider metadata の provenance と activation disposer 後の消失を boot 相当の module import で検証し、manifest 宣言だけの hand-mount を成功扱いしない。tenant overlay/facet loader 全体との実合成は未完了。
- 2026-08-17: DH-08 の第三段として activated plugin の `prompt_sections` を `reasoning-runtime-instructions` へ接続した。承認済み contribution のみ provider runtime instruction として pipeline prompt に合成され、deactivate 後は消失する boundary test を追加した。facet の consumer 接続、全 direct reasoning caller の prompt visibility receipt 自動付与は未完了。
- 2026-08-17: DH-06 の第七段として `run_pipeline` の reasoning leaf と actuator reasoning dispatch に mission path・task/context pack・knowledge refs から `prompt_visibility` を自動供給した。一般 reasoning backend の metadata-only ledger と同じ fail-closed 境界を pipeline へ広げ、直接 caller が手動で context を組み立てなくても model-visible 内容を mission-local ledger から追跡できる。PI-05 journal との再構築統合、mission 外の reasoning caller の自動 context 解決は未完了。
- 2026-08-17: DH-08 の第四段として plugin の virtual facet contribution を `facet-registry` の実 resolver に接続した。承認済み contribution は kind/content/provenance を保持した `ResolvedFacet` として解決され、同名 plugin の曖昧性は拒否され、activation disposer 後は解決不能になる。managed pack の facet file と tenant overlay の narrow-only filter 全体への統合は未完了。
- 2026-08-17: DH-06 の第八段として reasoning backend の direct caller が明示 options を渡さない場合も、既存 mission (`MISSION_ID`) を path resolver で確認できれば metadata-only prompt visibility receipt を自動生成するようにした。存在しない mission のために暗黙の ledger path は作らず、直接 caller の mission 外互換性を維持しながら「model-visible ⟺ logged」の実効範囲を広げた。task/context-pack/knowledge refs の ambient 解決と PI-05 journal への統合は未完了。
- 2026-08-17: DH-16 の第一段として `external-hook-bridge` を追加し、Claude Code の grouped event config と Codex-style normalized `hooks[]` を `LifecycleHookEngine` の command registration へ変換できるようにした。外部 command の `permissionDecision` (`deny|ask|allow`) を engine の強い順序へ写像し、`ask` は非対話境界で fail-closed、batch disposer で登録解除できる。実際の provider config loader への自動発見、sticky halt/drain-on-dispose、interactive approval surface への `ask` 接続は未完了。
- 2026-08-17: DH-16 の第二段として `LifecycleHookEngine({stickyHalt:true})` と `clearHalt()` を追加した。外部 deny/engine block 後は後続 fire を同じ理由で fail-closed にし、後から登録された allow hook でも解除できない。既定 engine は後方互換のため非 sticky のまま。さらに `whenIdle()` と bridge disposer の drain を追加した。第三段として project-local の Claude (`.claude/settings*.json`) / Codex (`.codex/hooks.json`) 設定候補を secure-io で deterministic に発見し、明示的な `trustResolved:true` が無い限り登録しない境界を追加した。不正設定は部分登録せず skipped 診断へ落とす。global user config の自動発見、interactive ask surface 接続、default engine への暗黙登録は未完了。
- 2026-08-17: DH-16 の第三段として global Claude/Codex config の discovery を明示 `includeGlobal` opt-in と `globalTrustResolved` の別承認へ接続した。global path は HOME 配下に限定し、project trust だけでは登録できない。既定 discovery は project-local のまま維持し、global config の暗黙実行を防ぐ回帰テストを追加した。interactive ask surface 接続と default engine への暗黙登録は未完了。
- 2026-08-17: DH-10/PI-15 の第一段として goal driver に `shouldStopAfterTurn` を追加した。現在の model/tool turn は中断せず、turn boundary でのみ cooperative yield → `paused` とし、既存の cold resume/journal 経路を利用できる。queue は非 wake の `inject` delivery も型付きで受け付ける。pre-step admission chain と queue inbox の実 worker 接続は未完了。
- 2026-08-17: DH-10/PI-15 の第二段として mission の goal-driven worker に共有 input queue を接続した。各 turn boundary で `steer → follow_up → next_run → inject` を消費し、`next_run` は再起動後も mission-local log から復元する。prompt には未信頼データとして明示し、turn 中の割込みと worker wake は行わない。続く段で single-shot dispatch にも同じ queue payload を A2A prompt/visibility ledger へ接続した。pre-step admission chain と task/agent 別 queue scope は未完了。
- 2026-08-17: DH-10/PI-15 の第三段として SO-03 の surface steering に `steer:` / `follow-up:` 明示コマンドを追加し、session が所有する mission queue へ metadata 付きで enqueue するようにした。queue は既存の turn-boundary delivery と同じ未信頼データ経路へ入り、surface 応答は現在の turn を中断しないことと次の action を示す。pre-step admission chain、task/agent 別 queue scope、非明示的な自然言語からの自動 enqueue は未完了。
- 2026-08-17: DH-10/PI-15 の第四段として goal worker に serial な `preStep` admission chain を追加した。各 hook は順序どおりに model-visible message を追加でき、`reject` は model/tool 呼び出し前に goal を pause する。queue の inbox、pre-step、turn execution の境界を別々のテストで固定し、task/agent 別 queue scope と非明示的な自然言語からの自動 enqueue は未完了。
- 2026-08-17: DH-10/PI-15 の第五段として input queue entry に任意の task/agent/session scope を追加し、single-shot と goal-driven worker の turn-boundary consume に同じ filter を接続した。mission-wide broadcast は維持し、scope 付き steer/follow-up/next_run/inject は対象 worker 以外から消費できない。surface 外の delivery API と非明示的な自然言語からの自動 enqueue は未完了。
- 2026-08-17: DH-10/PI-15 の第六段として `enqueueSurfaceAgentInput` を surface→mission queue の明示 delivery API として追加し、SO-03 steering route を経由する全 `steer|follow_up` に surface/channel/thread provenance を付与した。API は分類済み command のみ受け付け、自然言語を暗黙に queue 化しない。agent runtime のプロセス間 wake と全 surface delivery の統一は未完了。
- 2026-08-17: DH-11 の第一段として `sandbox-policy.ts` に provider-neutral な `SandboxPolicy` と enforcement fact(`full|partial`)、`requireSandboxEnforcement`、Codex projection を追加した。Codex app-server adapter と CLI reasoning backend の sandbox request shape を同じ resolver に接続し、agy の verified read-only 不在と danger-full-access を `partial` として明示する。続く段で `permission-presets.json` を唯一の named bundle source とし、`readonly|edit|full` の resolver と非永続 `custom` 導出を追加した。adf-guardrails/secure-io/egress の全判定統合、provider capability probe による enforcement の実測化は未完了。
- 2026-08-17: DH-11 の第二段として provider permission matrix の explorer×agy 投影を sandbox enforcement fact と突合した。agy は read-only filesystem を検証できないため、`--sandbox` を付けたまま許可せず typed refusal を返し、partial enforcement を full sandbox と誤認しないことを回帰テストで固定した。adf-guardrails/secure-io/egress の全判定統合と provider capability probe による実測化は未完了。
- 2026-08-17: DH-13 の第一段として secret resolver に operation-scoped `SecretReference{env,scope,operation}`、非機密 `describeSecretResolver()`、sync/async の毎回解決 API を追加した。`getSecret` と browser secret fill、service secret resolution が operation context を伝播し、resolver の describe は `configured|writable` 以外を公開しない。rotation は resolver の値をキャッシュせず次 request へ反映する。secret actuator/全 secret consumer の reference 化、operation ごとの実 provider policy、credential rotation の外部 integration は未完了。
- 2026-08-17: DH-14 の第一段として `ToolRepeatAdvisor` を追加し、PTC の typed-op 呼び出しを op+引数 hash 単位で数えるようにした。許可・拒否を問わず同じ request を数え、`[3,5,8]` で raw args を保存しない注意メッセージを `on_repeat` と lifecycle event に渡す。さらに `spillTextBestEffort`/`readSpilledText` を secure-io の 0700 directory・exclusive create・0600 file・opaque locator 境界へ接続し、spill 失敗時は元の値を保持する。続く段として op registry に `operation_timeouts_ms` を追加し、ADF preparation が明示値を優先した上で宣言値を step params・graph node・run graph artifact・actuator trace へ伝播するようにした。実処理を無理に Promise race で切断せず、既存 actuator の `timeout_ms` 契約を安全に利用する第一段であり、全 operation の宣言拡張と abort signal 対応は未完了。
- 2026-08-17: DH-15 の第一段として `docs/developer/design-notes/{proposed,implemented,rejected}` と `docs/developer/postmortem/` を追加し、frontmatter の status/evidence/rationale を `check:design-ledger` で fail-closed に検査するようにした。DeepSeek harness の preflight 採択と runtime plugin mount 非採用、関連 postmortem を初期台帳へ記録した。設計判断の全 PR/mission への自動 backlink と review workflow への強制入力は未完了。
- 2026-08-17: DH-12 の第一段として continuable delegation に durable `child_session_id` と `activation_count` を追加し、`claimDelegatedTaskActivation` が secure record を lock 下で更新して cold resume を一度だけ許可するようにした。`resumeDelegatedTask` は dispatch 前に claim するため二重 resume は provider を呼ばず fail-closed になる。さらに durable trace の `child_report` と owner-side `settlement`、background inbox の `report_provenance` を分離した。第二段として activation 後の backend 解決・prompt 構築・provider dispatch の失敗を `activation_status=failed` と bounded error として同じ durable record に保存し、失敗した one-shot activation を再試行できないことを回帰テストで固定した。第三段として child-session ごとの durable `next_run` inbox を追加し、cold-resume follow-up は inbox enqueue→consume を経由してから provider へ渡す唯一の child input queue とした。第四段として `registerDelegatedTaskWorker`/`wakeDelegatedTaskWorker` を追加し、child worker の boot 時 replay、enqueue 後の coalesced wake、`fromInbox` 限定の cold resume を実装した。実プロセスの supervisor spawn/再起動自体は既存 runtime supervisor との統合が未完了。
- 2026-08-17: DH-12 の第五段として `buildDelegatedTaskWorkerProcessSpec` / `spawnDelegatedTaskWorkerProcess` と `scripts/delegated_task_worker.ts` を追加し、completed/failed continuable child の durable inbox を runtime supervisor 管理下の明示的な one-shot worker process から `register→wake→resume(fromInbox)` で消費できるようにした。argv/metadata へ follow-up 本文を渡さず、owner・child session・activation guard を維持する。supervisor daemon の外部 RPC 自動起動、worker restart policy、実 provider E2E は未完了。
- 2026-08-17: DH-12 の第六段として agent-runtime supervisor daemon に `delegated_enqueue` IPC と client API `enqueueDelegatedTaskViaSupervisor` を追加した。daemon が durable inbox へ本文を先に enqueue し、同じ delegation の worker が稼働中なら再利用、未起動/終了済みなら runtime supervisor 管理下で一度だけ spawn する。daemon の coalesced start と malformed payload の回帰を固定し、IPC 以外の自動 provider restart policy、activation 後の worker crash recovery、実 provider E2E は未完了。
- 2026-08-17: DH-12 の第七段として supervisor daemon が worker の exit を監視し、未 claim の durable `next_run` inbox が残る場合だけ最大 3 回の指数バックオフ restart を行うようにした。activation は `pending → claimed → completed|failed` として親 snapshot へ記録し、正常完了を再実行せず、claim 後の crash は one-shot 制約を維持したまま bounded failure として監査する。restart exhaustion、pending inbox の有無、activation completion の回帰テストを追加した。実 provider E2E と provider 自体の個別 restart policy は未完了。
- 2026-08-17: DH-03 の第二段として seam provider metadata に deterministic な `reason` を追加し、`pnpm bindings --dump --json` が provenance/source だけでなく現在の binding 理由も出力できるようにした。未指定の builtin/plugin/provider は provenance または source から安定した fallback reason を導出し、登録順や実装値に依存しない。選択理由の policy/env/tenant/probe 実測と全 seam の provider override は未完了。
- 2026-08-17: DH-03 の第三段として human-readable な `pnpm bindings --dump` にも JSON dump と同じ deterministic binding reason を表示するようにした。運用者が provenance/source と選択理由を同じ出力で確認できる。選択理由の policy/env/tenant/probe 実測と全 seam の provider override は未完了。
- 2026-08-17: DH-12 の第八段として実際の `spawnDelegatedTaskWorkerProcess` を使う process-level E2E を追加した。stub backend の実 worker が durable inbox を `register→wake→resume(fromInbox)` で消費し、親 snapshot を `activation_status=completed` へ更新し、queue を空にすることを検証する。実 provider credentials を使う live E2E と provider 個別 restart policy は引き続き未完了。
- 2026-08-17: DH-13 の第二段として service binding が credential fallback candidate を `SecretReference[]`（env/scope/operation のみ）として保持するようにした。実際の secret 値の解決は従来どおり最終的な secret-guard boundary に限定し、候補順を壊さず rotation/fallback を追跡できる。service binding と resolver の回帰テストで、reference に値を混入させず operation scope を保持することを固定した。secret actuator/全 secret consumer の late-bound reference 化、operation ごとの実 provider policy、credential rotation の外部 integration は未完了。
- 2026-08-17: DH-01 の追加段として code / wisdom actuator の直接 `reconcile` 公開入口にも標準 preflight と repaired input の受け渡しを接続した。ADF 内部 step だけでなく strategy を直接読む経路も `scope → ADF → egress → spend` waterfall を通り、`check:op-preflight-coverage` は29から31境界へ拡張した。wisdom の既存 contract test は tenant 必須の security scope と terminal preflight denial を明示する形へ補正し、両 actuator の関連テスト・型チェックを通過した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として ADF 外の artifact actuator 直接操作（artifact write/read/list/delivery pack）にも標準 preflight を接続し、拒否判定前に成果物書込みが発生しないことを回帰テストで固定した。`check:op-preflight-coverage` は31から32境界へ拡張した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として system actuator の直接 `reconcile` も標準 preflight を通し、strategy JSON の読み込み前に block/ask を終端判定できるようにした。repaired な strategy path/options は実行へ引き継ぎ、拒否時に strategy を読まない回帰テストを追加した。`check:op-preflight-coverage` は32から33境界へ拡張した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として system の `computer_interaction` direct action も `system:computer_interaction:<type>` preflight を通すようにした。repaired action params を OS automation へ渡し、拒否時は click/type/key 等を開始しないことを回帰テストで固定した。system actuator の同一公開境界内で reconcile と OS direct action の governance を統一した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。

## 10. 検証コマンド(実装時)

- DH-01: `pnpm vitest run libs/core/op-preflight.test.ts libs/core/op-preflight-defaults.test.ts` + `pnpm run check:op-preflight-coverage`
- DH-02: `pnpm vitest run libs/core/seam.test.ts` + 各 seam の移行テスト、`grep -c "export function reset" libs/core/*.ts` の減少をラチェット
- DH-03/07: `pnpm bindings --dump --json`、`pnpm run generate:capability-seams && pnpm run check:capability-seams`
- DH-06: `pnpm run check:module-invariants`
- DH-08: `pnpm plugin:install` → deactivate → 全貢献消失の boundary test

## 11. 関連

- [PI_ADOPTION_PLAN_2026-08-16](./PI_ADOPTION_PLAN_2026-08-16.ja.md)(PI-08 preflight repair ↔ DH-01、PI-09 provenance/narrow-only ↔ DH-08、PI-10/13 ↔ DH-04、PI-15/16 ↔ DH-10/12)
- [TAKT_ADOPTION_PLAN_2026-08-16](./TAKT_ADOPTION_PLAN_2026-08-16.ja.md)(TK-04 facet ↔ DH-09、TK-03 ↔ DH-10)
- [QM_ADOPTION_PLAN_2026-08-01](./QM_ADOPTION_PLAN_2026-08-01.ja.md)(QM-06 backend 能力宣言 ↔ DH-04、QM-07 skill pack ↔ DH-08)
- [KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16](./KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)(KO-06 `pnpm scope` ↔ DH-03)
- `knowledge/product/governance/adapter-first-extension-policy.md`(4 層規則、DH-02 の土台)
- `knowledge/product/governance/kyberion-development-practices.md`(登録儀式、DH-07 の流儀)
- `docs/developer/EXTENSION_POINTS.md` / `plugins/README.md`(DH-08 で更新対象)
