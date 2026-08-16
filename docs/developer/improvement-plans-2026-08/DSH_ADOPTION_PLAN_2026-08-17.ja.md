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
status: planned
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

**dsh の設計**: preset = `sandbox/mode` + `approval/policy` の束、`custom` は導出のみ、enforcement は各 knob が持ち preset は意図を記録するだけ。sandbox policy は 1 か所で解決し enforcement fact `full|partial` を報告。**実装**: `provider-permission-profiles`(readonly/edit/full)と approval policy を独立 knob とし、`permission-presets.json` で束ねる。`adf-guardrails`/`secure-io`/egress が別々に持つ sandbox 判定を `sandbox-policy.ts` に集約し、`partial` を受け入れられない呼び手は拒否できるようにする。

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

- 2026-08-17: read-only 分析(3 経路: Cordis plugin 合成モデル・seam・boot 合成・runtime mount・型安全・自認コスト / runtime 意味論・不変条件・governance・multi-agent・永続・テスト / kyberion 側の拡張機構 12 軸の実コード突合)に基づき策定。kyberion 側の事実(27 register/get seam、`unregister*` 0 件、116 `reset*`、`buildReasoningRuntimeBundle` 20 分岐、`path-resolver.ts:190` のファイル規約 dispatch、skill plugin 2 hook、approval 約 42 call-site、`LifecycleHookEngine` 並列 boolean、48 `check:*`)は実コードで確認。実装未着手。

## 10. 検証コマンド(実装時)

- DH-01: `pnpm vitest run libs/core/op-preflight.test.ts` + `pnpm run check:op-preflight-coverage`(新設)
- DH-02: `pnpm vitest run libs/core/seam.test.ts` + 各 seam の移行テスト、`grep -c "export function reset" libs/core/*.ts` の減少をラチェット
- DH-03/07: `pnpm bindings --dump --json`、`pnpm run gen:capability-seams && pnpm run check:reference-drift`
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
