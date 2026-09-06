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
last_updated: 2026-08-30
status: active
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
| 宣言と実装の突合           | ~35 `verify-*` gate、独立 AST backstop、package-attributed invariants、生成 capability graph                          | **48 `check:*`**(43 が `validate`): generate-and-diff SSoT(`generate:op-registry -- --check`, `agents:generate -- --check`, `check:env-registry`)、**dead-declaration 検出**(`check:event-wiring`「宣言だけの機能は不在より悪い」)、boundary allowlist ceremony(`kyberion-development-practices.md:16-28`)            | **kyberion 同等〜優位**           |
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
| DH-05 | op resolver 化(registry が実装を解決、managed pack が `namespace:op` を provenance 付きで寄与)                         | P1     | L    | `generate:op-registry -- --check` / KD-06 plugin gate                          |
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

**dsh の設計**: `ctx.tools.register` で plugin が tool を足し、registry が実行する。**kyberion**: `namespace:op` → ファイル規約 import、op registry は validator。**実装**: `actuator-op-registry.json` を resolver の SSoT にし(`domain → module, ops[]`)、builtin actuator はそのまま、managed pack は `provides.ops` を provenance 付きで登録。`generate:op-registry -- --check` は生成・差分検査を維持しつつ「解決可能性」も検査。ADF 側の変更なし。

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
- 2026-08-28: DH-01 のレビュー修正として media actuator の公開 `handleMediaAction` 入口にも `media:pipeline` の標準 preflight を接続し、修復済み steps/context/options を実行へ渡すようにした。direct dispatch が block された場合に media operation が開始されない回帰を追加し、coverage checker を34境界で検査できるようにした。approval metadata の全 actuator 展開と個別 gate の全面置換は継続課題である。
- 2026-08-17: DH-07 の第一段として `generate:capability-seams`（`--check` で差分検査）を追加し、移行済み 20 seam の declaration/provider/consumer 役割を `docs/developer/CAPABILITY_SEAMS.md` に決定的に生成する。宣言 module の `defineSeam`、consumer file の存在、runtime catalog との対応を fail-closed で検査する。独立 TypeScript AST backstop と未移行 seam の全27件化は未完了。
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
- 2026-08-31: DH-03 の第四段として reasoning backend の実選択関数から safe な provenance reason を生成し、`requested`、環境変数名、CLI provider probe の healthy 判定、fallback 順、tenant/organization/project overlay の適用を seam binding metadata へ接続した。環境変数の値や secret は記録しない。policy/bootstrap/seam の 38 テスト、`build:packages`、canonical full gate（67/67）で確認した。全 seam の provider override、外部 provider の実 probe 証跡、未移行 seam の runtime catalog 化は継続課題である。
- 2026-08-17: DH-12 の第八段として実際の `spawnDelegatedTaskWorkerProcess` を使う process-level E2E を追加した。stub backend の実 worker が durable inbox を `register→wake→resume(fromInbox)` で消費し、親 snapshot を `activation_status=completed` へ更新し、queue を空にすることを検証する。実 provider credentials を使う live E2E と provider 個別 restart policy は引き続き未完了。
- 2026-08-17: DH-13 の第二段として service binding が credential fallback candidate を `SecretReference[]`（env/scope/operation のみ）として保持するようにした。実際の secret 値の解決は従来どおり最終的な secret-guard boundary に限定し、候補順を壊さず rotation/fallback を追跡できる。service binding と resolver の回帰テストで、reference に値を混入させず operation scope を保持することを固定した。secret actuator/全 secret consumer の late-bound reference 化、operation ごとの実 provider policy、credential rotation の外部 integration は未完了。
- 2026-08-17: DH-01 の追加段として code / wisdom actuator の直接 `reconcile` 公開入口にも標準 preflight と repaired input の受け渡しを接続した。ADF 内部 step だけでなく strategy を直接読む経路も `scope → ADF → egress → spend` waterfall を通り、`check:op-preflight-coverage` は29から31境界へ拡張した。wisdom の既存 contract test は tenant 必須の security scope と terminal preflight denial を明示する形へ補正し、両 actuator の関連テスト・型チェックを通過した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として ADF 外の artifact actuator 直接操作（artifact write/read/list/delivery pack）にも標準 preflight を接続し、拒否判定前に成果物書込みが発生しないことを回帰テストで固定した。`check:op-preflight-coverage` は31から32境界へ拡張した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として system actuator の直接 `reconcile` も標準 preflight を通し、strategy JSON の読み込み前に block/ask を終端判定できるようにした。repaired な strategy path/options は実行へ引き継ぎ、拒否時に strategy を読まない回帰テストを追加した。`check:op-preflight-coverage` は32から33境界へ拡張した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-17: DH-01 の追加段として system の `computer_interaction` direct action も `system:computer_interaction:<type>` preflight を通すようにした。repaired action params を OS automation へ渡し、拒否時は click/type/key 等を開始しないことを回帰テストで固定した。system actuator の同一公開境界内で reconcile と OS direct action の governance を統一した。残る approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは未完了。
- 2026-08-29: DH-01/SX-10 のレビュー修正として Android/iOS の custom pipeline loop も `runActuatorPipeline` へ移行した。結果配列、最大 step 数、失敗時停止、mobile domain handler は維持し、step の placeholder 再帰解決・標準 preflight・repaired input の受け渡しだけを shared SDK に統一した。preflight listener が実値を観測する回帰を追加し、直接 loop の raw admission ずれを防いだ。approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは継続課題である。
- 2026-08-29: DH-01 のレビュー修正として `check:op-preflight-coverage` の検出をコメント・文字列中の例ではなく実呼び出し構文に限定した。共有 SDK/ADF engine の preflight 実装と各 public boundary の接続を同じ checker が検査し、コメントだけの synthetic boundary が green にならない回帰テストを追加した。approval metadata の全 actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは継続課題である。
- 2026-08-29: DH-01/SX-10 の追加レビュー修正として Vision actuator の action-form custom pipeline loop を `runActuatorPipeline` へ移行した。schema の `action` step を shared runner の `op` ABI へ明示変換し、単発 action と legacy media-generation fallback の domain 実行は維持した。Vision の pipeline 回帰を追加し、残る custom direct helper の棚卸しを継続する。
- 2026-08-29: DH-01/SX-10 の追加レビュー修正として Media Generation actuator の `continue_on_error` custom pipeline loop を `runActuatorPipeline` へ移行した。action-form step を shared runner の `op` ABI へ明示変換し、step failure の集約、継続実行、trace span と result envelope は維持した。残る custom direct helper の棚卸しを継続する。
- 2026-08-29: DH-01/SX-10 の追加レビュー修正として Voice actuator の pipeline loop も `runActuatorPipeline` へ移行した。action-form と top-level action contract の step 全体を preflight input として保持し、既存の単発入口、trace、失敗時 envelope を維持したまま shared admission に統一した。残る custom direct helper の棚卸しを継続する。
- 2026-08-29: DH-01/SX-10 の追加レビュー修正として Orchestrator の control-flow pipeline loop も `runActuatorPipeline` へ移行した。step 上限、timeout、if/while/nested pipeline、context persistence は維持し、capture/transform/apply/control の domain dispatch だけを execute callback に残して、step admission を shared runner に統一した。残る custom direct helper の棚卸しを継続する。
- 2026-08-29: DH-01 の追加レビュー修正として `runActuatorPipeline` と `executeAdfSteps` が step-level `approval_required` / `_approval_required` metadata を共通 preflight の `requiresApproval` へ伝播するようにした。承認済み判定は trusted caller callback、human presence は caller signal のみを受け付け、未指定または未承認は ask/block のまま handler を実行しない。approval metadata の全 direct actuator 展開と個別 gate の全面置換は継続課題である。
- 2026-08-29: DH-01/PI-06 の追加レビュー修正として、共有 trace replay validator が event timestamp の欠損・不正値と未登録 span 名を strict mode で fail-closed に拒否するようにした。現行 extension namespace を明示 registry 化し、Chronos/Terminal/history/intent の persisted consumer が schema 不正 event/span を表示・集計しない境界を回帰テストで固定した。全 custom direct helper と Exact telemetry 型の全面適用は継続課題である。
- 2026-08-29: DH-01 の追加レビュー修正として、service actuator と Super-Nerve の個別 preflight が `_approval_granted` を入力/contextから承認済み扱いしないようにした。service の公開入口は trusted caller option のみで既存承認を受け付け、未信頼 approval payload の回帰を追加した。個別 gate の全面統一は継続課題である。
- 2026-08-29: DH-01/PI-08 の追加レビュー修正として、Chronos の deliverable inbox、trace feed、raw trace log、knowledge-ref の各 read boundary に viewer の tierAccess を適用した。mission state/record metadata/path から tier を解決し、personal や unknown tier の record を masked viewer へ返さない回帰を追加した。残る直接 read boundary の棚卸しは継続する。
- 2026-08-29: DH-01/PI-08 の追加レビュー修正として、Chronos の `runtime-file` 直接 read にも project path/registry の tier・tenant scope を適用した。tier を解決できない legacy path は拒否し、confidential project skeleton を public-only viewer が読めない回帰を追加した。残る直接 read boundary の棚卸しは継続する。
- 2026-08-29: DH-01/PI-08 の追加レビュー修正として、Chronos `intelligence` 集約の active mission/project/work coordination/recent artifact 投影にも viewer tierAccess を適用した。public-only viewer が confidential の運用データを集約レスポンスから受け取らないよう、project/mission/record の tier を入力段で fail-closed にした。残る集約補助データの tier metadata 監査は継続する。
- 2026-08-29: DH-01/PI-08 の追加レビュー修正として、Chronos `intelligence` の履歴/control/owner/agent/A2A/runtime/approval 補助投影にも viewer tierAccess を適用した。GET と SSE の両経路を同じ mission scope 判定へ接続し、public-only viewer の confidential metadata 混入を防いだ。project track/mission seed、runtime 集計、mission/project control の POST 境界も許可 tier 基準へ揃えた。集約補助データの tier metadata 監査は継続する。

- 2026-08-29: DH-01/PI-08 の追加レビュー修正として、legacy Chronos `/api/agent` の deterministic pipeline shortcut を localadmin 専用へ制限し、input path を repository 内 `pipelines/**/*.json` に限定した。readonly viewer の実行と `../` による path escape を防ぐ resolver を追加し、helper/route 回帰を通過した。残る直接実行入口の棚卸しは継続する。
- 2026-08-30: DH-02 の追加 wave として、未移行だった `a2a-route`、`agent-runtime-ensurer`、`super-nerve-executor`、`provider-health-resolver` の4 sole portを `defineSeam`/`coreSeamCatalog` へ移行した。登録は disposer を返し、二重 provider は last-wins せず拒否する。未初期化時の conservative fallback と既存の route replacement エラーは維持し、bindings generator の declaration/consumer role と回帰テストを追加した。これにより runtime catalog 上の seam は 25 件となり、残る未移行登録口と `reset*` の全面廃止は継続課題である。
- 2026-08-30: DH-02 の完了 wave として、残っていた `identity-context-resolver` と `mission-worker-core-dispatcher` も `coreSeamCatalog` の sole seam へ移行した。bootstrap 時の安全な identity fallback、未初期化 dispatcher の拒否、重複登録拒否、disposer による復元を維持し、bindings dump は計画上の 27 seam と一致した。DH-02 の27 seam catalog化と生成グラフは完了し、`reset*` の全面廃止と未分類の低層 registration bridge は継続課題である。
- 2026-08-30: DH-02 の追加レビュー修正として、security-sensitive な `risky-approval-handler` も sole seam 化した。未登録時の pending fallback、既存の replacement 拒否コード、同一 handler の idempotent registration を維持し、approval registry の provider が bindings dump と生成グラフに現れるようにした。計画上の27 seamに加えた28件目の登録口であり、残る未分類の低層 registration bridge と `reset*` の全面廃止は継続課題である。
- 2026-08-31: DH-01 のレビュー修正として、orchestrator 公開 wrapper の `reconcile` 入口にも標準 preflight を追加し、strategy path のリポジトリ外参照・symlink traversal・未承認 project-local strategy の読み込みを拒否するようにした。strategy の読み込み前に trust と admission を完了し、回帰テストと `check:op-preflight-coverage` の境界登録で固定した。approval metadata の全 direct actuator 展開、個別 gate の全面置換、全 custom direct helper の棚卸しは継続課題である。
- 2026-08-31: DH-01/PI-03 の追加レビュー修正として、Chronos scheduler の登録・解決経路で相対 `..` による pipeline path escape を拒否し、実行対象を `pipelines/**/*.json` の repository-owned regular file に限定した。symlink 配下・symlink 自体の scheduled pipeline は登録/実行対象から除外し、scheduler の path portability を保ったまま scope 回帰を追加した。CLI/operator の全 direct loader と承認記録の接続、その他の直接 read boundary の棚卸しは継続課題である。
- 2026-08-31: DH-16/PI-03 の追加レビュー修正として、project-local external hook config の登録を path ごとの hash-bound `project-trust` approval に接続した。trust 済み boolean だけでは設定変更後の command を許可しないよう、authenticated human approval の content hash を `external-hook-discovery` が read 前に再検証し、未承認・改変 config は partial registration せず `skipped` へ落とす。external hook 5 テスト、対象 lint、build/full gate で確認した。global interactive ask surface と default engine への暗黙登録は継続課題である。
- 2026-08-31: DH-16/PI-03 の追加レビュー修正として、内部 `loadLifecycleHookEngine` を canonical governance config のみ読む loader へ限定した。任意の外部 JSON を command hook として登録できる path を閉じ、別 provider config は external discovery の trust/approval 境界へ分離する。19 テスト、対象 lint、build/full gate で確認した。global interactive ask surface と default engine への暗黙登録は継続課題である。
- 2026-08-31: DH-01/PI-03 の追加レビュー修正として、`pipeline-preview` と CLI `preview` の input/ref reader に repository root／symlink 境界を接続した。読み取り専用 preview であっても外部 JSON の step 内容を可視化経路へ混入させないようにし、13 テスト、対象 lint、build/full gate で確認した。その他の直接 read boundary の棚卸しは継続課題である。
- 2026-08-31: DH-11 の追加レビュー修正として、`sandbox-policy.ts` の resolved policy を async-safe な実行コンテキストへ接続した。ADF handler は partial enforcement を dispatch 前に拒否し、network-disabled は ADF HTTP hook・`validateUrl`・egress policy の全経路で deny、read-only／writable roots は secure-io の write permission へ伝播する。sandbox policy 5 テストを含む関連 83 テスト、対象 lint、typecheck で確認した。provider capability probe による外部 CLI の enforcement 実測と全 provider adapter の context wiring は継続課題である。
- 2026-08-31: DH-11/PI-03 の追加レビュー修正として、provider capability registry／scan policy の明示 override path を repository root・path component symlink 検査へ接続した。既定の governed catalog と schema 検証は維持し、repository 外 override を `[RESOURCE_PATH_SCOPE]` で拒否する回帰を追加した。provider capability scanner 9 テスト、対象 lint、typecheck、`build:packages`、canonical full gate（67/67）で確認した。外部 CLI の sandbox enforcement 実測と全 provider adapter の context wiring は継続課題である。
- 2026-08-31: DH-11/PI-03 の追加レビュー修正として、active sandbox policy を provider permission matrix へ伝播し、Claude／Codex／AGY／Grok の CLI delegation／native subagent／structured path と legacy agent adapter に適用した。read-only は explorer へ狭め、AGY の partial enforcement は spawn 前に拒否し、network-disabled は reasoning outbound choke point で拒否する。provider capability scanner の evidence probe 失敗も capability を available にせず、個別 probe の結果を返す fail-closed 契約へ変更した。関連 adapter／scanner／egress／registry **151 tests passed**、対象 lint、typecheck、`build:packages`、canonical full gate で確認した。実 CLI に対する OS-level sandbox enforcement の live probe は、provider 側の安定した非対話 probe 契約が必要なため継続課題である。

- 2026-08-31: DH-11/PI-03 の追加レビュー修正として、Gemini CLI の delegation／structured／prompt 経路へ active sandbox policy を `--sandbox`／`--approval-mode` として射影し、`extraArgs` による `-y`／approval mode／sandbox の上書きを除去した。Copilot ACP は sandbox projection を表現できないため session boot 前に typed refusal とし、provider capability registry には実モデル実行を伴わない `--help` flag-support probe（supported／unsupported／unknown）と schema を追加した。関連 66 tests、lint、typecheck、`build:packages`、canonical full gate **67/67** で確認した。help flag は OS-level enforcement の証明ではなく、実 CLI の非対話 enforcement probe は継続課題である。
- 2026-08-31: PI-03 の direct loader 再レビューとして、browser onboarding の active profile／voice sample path、mission process template の mission-local path、deal store／deal document の customer path を `assertSafeRepositoryPath` と canonical tenant slug／deal ID 検証へ接続した。repository 外、path component の symlink、invalid tenant slug／deal ID は読み書き前に fail-closed とし、契約テンプレートも knowledge 配下へ限定した。対象 **30 tests**、lint、typecheck、package build、canonical full gate **67/67**、`git diff --check` で確認した。未監査の direct loader 全件 inventory と実 CLI の enforcement probe は継続課題である。
- 2026-08-31: PI-03 の mission lifecycle direct loader 再レビューとして、completion の mission／evidence／receipt／deliverable path を `assertSafeRepositoryPath` と mission-relative confinement へ統一した。外部 mission directory、絶対／traversal path、symlink component は lifecycle artifact の読書き前に fail-closed とし、meeting deliverable の customer root／mission id も再検査した。関連 **25 tests**、lint、typecheck、package build、canonical full gate **67/67**、baseline pipeline、`git diff --check` で確認した。未監査の direct loader 全件 inventory と tenant-aware discovery は継続課題である。
- 2026-08-31: PI-03 の peer runtime recovery direct loader 再レビューとして、tenant-scoped quarantine path、manifest、peer directory、move source／destination、recovery event log の repository 所属と symbolic link を復元前に再検査した。tenant root の prefix boundary と peer ID の path segment も fail-closed にし、既存の authenticated human approval／fresh heartbeat gate は維持した。関連 **3 tests**、lint、typecheck、package build、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。
- 2026-08-31: PI-03 のレビュー修正として、tenant design resolver の `customerId` 経路が fixture／設定済み `rootDir` ではなく実 repo の customer overlay を参照していた残存を修正した。明示 tenant context がある場合は対象 tenant の confidential design だけを走査し、registry の `override_path` も `knowledge/confidential/{tenant}/design` 配下へ限定した。別 tenant の branding と personal-tier override を返さない回帰を追加し、関連 **11 tests**、対象 lint、typecheck、package build、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。
- 2026-08-31: PI-03 の追加レビュー修正として、mission phase gate／work graph projection／mission hygiene／planning progress の mission artifact 読み書きを `assertSafeRepositoryPath` へ接続した。mission directory、gate definition、NEXT_TASKS、TASK_BOARD、dispatch manifest の repository 所属と path component symlink を再検査し、外部内容を gate／operator 投影へ混入させない回帰を追加した。関連 **22 tests**、対象 lint、typecheck、package build、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。
- 2026-08-31: PI-03 の mission context pack 追加レビューとして、mission root、mission-state、dispatch manifest／response、context rollup／context-pack の読み書きを `assertSafeRepositoryPath` へ接続した。manifest 由来の外部 response path は model-visible seed へ取り込まず、symlinked mission root は build／save 前に fail-closed とした。関連 **8 files / 68 tests passed**、対象 lint、typecheck、5 package build、`git diff --check`、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。
- 2026-08-31: PI-03 の mission closure／governance／maintenance／orchestration event 追加レビューとして、mission artifact closure と purge/archive の全 destructive target、finish quality／review／marketing gate、runtime event／payload loader を `assertSafeRepositoryPath` へ接続した。symlinked mission/class path、外部 receipt／artifact／payload、unsafe archive target は読み書き・削除・移動前に fail-closed とし、purge sweep は全候補を先に preflight して部分適用を防止した。関連 **15 files / 125 tests passed**、対象 lint、typecheck、5 package build、`git diff --check`、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。
- 2026-08-31: PI-03 の mission retrospective 追加レビューとして、mission telemetry／NEXT_TASKS／dispatch manifest／retrospective report の読み書きを `assertSafeRepositoryPath` へ接続した。symlinked telemetry は統計・改善提案の入力へ取り込まず、mission-local report と shared queue の repository 所属を再検査した。関連 **16 files / 131 tests passed**、対象 lint、typecheck、5 package build、`git diff --check`、canonical full gate **67/67** で確認した。未監査の direct loader 全件 inventory は継続課題である。

## 2026-08-31: DH-11/PI-13 の追加レビュー修正として、provider conformance に runtime sandbox enforcement の明示 check を追加した。`--help` の flag evidence と OS-level write-sentinel evidence を分離し、live provider の probe 未実行を `unavailable`、sandbox write 成功を `failed` として受入れから除外する。矛盾した非該当証跡と空の evidence も拒否し、stub／API provider の非該当も暗黙に成功させず明示する。関連 18 tests、typecheck、`git diff --check` で確認した。実 CLI の非対話 probe と全 provider adapter の wiring は継続課題である。

## 2026-08-31: DH-11 の tenant boundary 追加レビューとして、customer channel binding discovery を tenant registry の active profile と repository／symlink path assertion へ接続した。customer overlay のディレクトリ名だけで tenant identity を作らず、未登録・suspended／archived tenant、registry profile の symlink、symlink overlay、tenant registry が返す overlay root を inbound binding／tenant resolution から除外する。関連 **2 files / 22 tests**、typecheck、package build、lint、`git diff --check`、canonical full gate **67/67**、baseline pipeline で確認した。provider CLI の実 CLI enforcement probe と全 direct loader inventory は継続課題である。

## 2026-08-31: DH-11 の audit mirror 追加レビューとして、任意の customer directory discovery を master audit chain の有効 tenant entry 起点へ変更し、secure-io の path assertion capability を mirror の read／write 全経路へ伝播した。symlink overlay と capability 欠落は fail-closed とする。関連 **4 files / 45 tests**、typecheck、package build、lint、`git diff --check`、canonical full gate **67/67**、baseline pipeline で確認した。provider CLI の実 CLI enforcement probe と全 direct loader inventory は継続課題である。

## 2026-08-31: DH-11 の runtime／service direct loader 追加レビューとして、service connection fallback、Cloudflare control-plane state、daemon heartbeat、service recording、provider capability cache、A2A secret、stimuli journal の保存・読込 path を `assertSafeRepositoryPath` へ統一した。service ID と recording ID の path segment 境界、任意 heartbeat root の repository confinement、symlink component 拒否を回帰で確認した。関連 **8 test files / 73 tests**、typecheck、package build、lint、`git diff --check`、canonical full gate **67/67 passed**、baseline pipeline、`check:op-preflight-coverage` **37 public boundaries passed** で確認した。provider CLI の実 CLI enforcement probe と全 direct loader inventory は継続課題である。

- 2026-08-31: DSH-12 の追加レビューとして、動的 session ID／request tag を使う browser conversation／realtime voice と plugin／desktop／screen の temporary artifact path を単一 path segment 検証＋`assertSafeRepositoryPath` に接続した。関連 **6 files / 75 tests passed**、typecheck、`git diff --check`、baseline pipeline passed で確認した。canonical full gate は約3分半後も子プロセス無応答のため停止し、provider CLI の OS-level 非対話 enforcement probe と未監査 direct loader 全件 inventory は継続課題として保持する。

- 2026-08-31: DSH-12 の working-memory path 再レビューとして、外部入力の `mdPath` を `active/` 配下の volatile face に限定し、symlink component を拒否する `read`／`nominate-promotion` 境界を追加した。QM-03 の UPDATE provenance 保持と consolidation threshold の read-only status も回帰で確認した。関連 **5 files / 52 tests passed**、`bench:memory`、typecheck、package build、lint、`check:op-preflight-coverage` **37 public boundaries passed**、`git diff --check` で確認した。provider CLI の OS-level 非対話 enforcement probe と未監査 direct loader 全件 inventory は継続課題として保持する。

- 2026-08-31: DSH-12 の capability registry 再レビューとして、working-memory actuator の self-described op catalog を registry generator に接続し、既存 weekly-review の3 working-memory opを capability resolution へ復旧した。全 op に bounded input schema／examples を付与し、weekly-review dry-run が `ready` になる回帰を追加した。関連 **3 files / 297 tests passed**、`generate:op-registry --check`、module invariants **6 registered invariants** で確認した。provider CLI の OS-level 非対話 enforcement probe と未監査 direct loader 全件 inventory は継続課題として保持する。

## 2026-08-31: DSH-12/PI-03 の direct loader 再レビューとして、project／mission／surface／session の動的 ID と明示 root を使う保存・読込境界へ repository／symlink 検査を追加した。AI-DLC、in-room minutes、ingest cursor、surface runtime、computer surface、trust／generation の証跡を含め、関連 **14 files / 78 tests passed**、typecheck、lint、package build、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と canonical loader 全件 inventory は継続課題として保持する。

## 2026-08-31: DH-16 の interactive ask／default engine 連携

外部 hook discovery が明示 engine にしか登録できず、`ask` を実際の surface で承認要求へ変換する process-wide 接続がなかった残存を修正した。hash-bound project trust を維持した `registerDiscoveredExternalLifecycleHooksOnDefaultEngine` を追加し、default lifecycle engine へ接続できるようにした。さらに `registerDefaultLifecycleHookApprovalSurface` と `fireDefaultLifecycleHooks` を追加し、surface resolver が返す場合だけ shared approval store へ materialize する。resolver 未登録・未対応・例外時は既存の fail-closed blocked outcome を維持し、global surface の silent last-wins 置換も拒否する。

検証: lifecycle hook／external discovery **3 files / 30 tests passed**、root／core typecheck、対象 lint、`git diff --check`。provider CLI の実 OS-level enforcement probe、未監査 direct loader 全件 inventory、残りの script registry 集約は継続課題である。

## 2026-08-31: PI-03 の environment capability direct loader 再レビュー

`mission-evidence.filename` と setup receipt の manifest／mission id が、JSON read／write 前に repository／mission-relative boundary を再検査していなかった残存を修正した。evidence filename は単一の安全な file name に限定し、receipt path は manifest id を検証したうえで `assertSafeRepositoryPath` を通す。manifest 一覧でも symlink／regular file 以外を採用しない。traversal、symlink、receipt path escape の回帰を追加した。

検証: environment capability **2 files / 54 tests passed**、core typecheck、対象 lint、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の meeting consent direct loader 再レビュー

`checkMeetingParticipationConsent` の mission id と `voice-consent.json` を、path resolver の返却値だけで読み取っていた残存を修正した。mission id を検証し、consent path を JSON read 前に `assertSafeRepositoryPath` へ通すことで、traversal と symlinked evidence directory を fail-closed にした。関連 **1 file / 11 tests passed**、対象 lint、typecheck、`git diff --check`、canonical full gate で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: EV-03/PI-03 の reflex definition loader 再レビュー

untrusted stimulus から自動 dispatch へつながる reflex definition loader に、repository／symlink／regular-file 境界を追加した。定義ディレクトリと各 `.adf.json` を `assertSafeRepositoryPath` と `safeLstat` で検査し、不正な1定義を skip して安全な定義の読み込みを継続する。関連 **1 file / 14 tests passed**、shared-nerve typecheck、対象 lint、`git diff --check`、canonical full gate で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の operator reasoning selection loader 再レビュー

default reasoning route が operator の `llm-selection.json` を path resolver の返却値だけで信頼していた残存を修正した。selection path を JSON read 前に `assertSafeRepositoryPath` へ通し、symlink 経由の provider／model 選択を fallback へ戻す回帰を追加した。関連 **2 files / 20 tests passed**、core typecheck、対象 lint、`git diff --check`、canonical full gate で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: I18N-01/05 の profile identity loader 再レビュー

timezone／locale／operator display name の identity file loader が profile root の返却値だけで `my-identity.json` を読んでいた残存を修正した。3経路を JSON read 前の `assertSafeRepositoryPath` へ接続し、symlink identity は timezone／locale の fallback または display name の fallback へ fail-closed する回帰を追加した。関連 **6 files / 49 tests passed**、core typecheck、対象 lint、`git diff --check`、canonical full gate で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: DA-01/PI-03 の tenant registry enumeration 再レビュー

tenant profile の一覧が `.json` suffix と tenant slug だけで symlink profile を登録候補へ含めていた残存を修正した。列挙段階で `safeLstat(...).isFile()` を要求し、`resolveTenant` の customer overlay error 変換も同じ保護範囲へ収束させた。関連 **1 file / 17 tests passed**、core typecheck、対象 lint、`git diff --check`、canonical full gate で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の secret-guard direct loader 再レビュー

personal connection の起動時 scan、connection document、secrets／grant file、backup path が secure I/O の権限検査だけで読込・書込へ進み、既存 path component／symlink を再検査していなかった残存を修正した。共通 `assertSafeRepositoryPath` と `safeLstat` を JSON／JSONL read 前へ適用し、symlink／非 regular file は秘密値 cache へ取り込まず、unsafe connection は fail-closed とした。関連 **1 file / 8 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の operator notification resource loader 再レビュー

operator notification preferences と未配送通知の shared log が path resolver の返却値だけで JSON read／JSONL append へ進んでいた残存を修正した。preferences／運用ログを `assertSafeRepositoryPath` へ接続し、symlink 経由の通知先読込・ログ書込を fail-closed にした。関連 **2 files / 8 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の procedure catalog reader 再レビュー

`readProcedureCatalog(filePath)` が公開 loader 自身では caller の path を再検査せず JSON read へ進み得た残存を修正した。catalog reader の入口で `assertSafeRepositoryPath` を必須化し、symlink／repository 外の procedure catalog を schema validation／procedure dispatch の入力へ混入させない回帰を追加した。関連 **2 files / 27 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の CLI input reader 再レビュー

公開 `readJsonFile`／`readTextFile` が caller の path を直接 secure reader へ渡していた残存を修正した。両入口で `assertSafeRepositoryPath` を必須化し、repository 外・symlink 経由の CLI input が JSON／text reader へ到達しない回帰を追加した。関連 **2 files / 3 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の mission-state direct loader 再レビュー

mission focus と project ledger が共有する JSON 補助 loader の入口で、caller の path を再検査せずに read／write へ進み得た残存を修正した。`readFocusedMissionId`／`writeFocusedMissionId`／`readJsonFileSafe` を `assertSafeRepositoryPath` へ接続し、symlink 経由の focus／ledger resource を fail-closed にした。関連 **2 files / 3 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の media catalog direct loader 再レビュー

media actuator の再帰 catalog discovery が JSON symlink を `loadJson` へ渡し、公開 `loadJsonValue` も単独呼出しでは path boundary を持たなかった残存を修正した。directory／leaf を `assertSafeRepositoryPath` と regular-file 検査へ接続し、tenant index／confidential tenant directory の symlink を候補から除外した。関連 **2 files / 2 tests passed**、actuator typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の fs-utils／orchestrator status loader 再レビュー

共通 `fs-utils` が symlink を regular file として返し、orchestrator の mission／project status snapshot がその結果を直接 JSON／README read へ渡していた残存を修正した。recursive／async enumeration で symlink と非 regular file を除外し、snapshot の JSON／README 入力を `assertSafeRepositoryPath` へ接続した。関連 **3 files / 25 tests passed**、core／actuator typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03/PI-19 の work coordination store loader 再レビュー

work coordination の runtime root が安全でも、既存の `items.jsonl`／`leases.jsonl`／`boards.json`／events leaf が symlink の場合に JSONL／JSON read・append・write が進み得た残存を修正した。共通 store helper の全 read／append／write 入口を `assertSafeRepositoryPath` へ接続した。関連 **2 files / 21 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03/PI-19 の mission-task-events loader 再レビュー

mission task event の mission-local／shared event path と authority state read が path resolver の返却値だけで JSONL／JSON 処理へ進み得た残存を修正した。event path、shared observability path、mission state path を `assertSafeRepositoryPath` へ接続し、symlinked mission resource を fail-closed にした。関連 **3 files / 5 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の source-analysis metadata loader 再レビュー

source-analysis の source root と package manifest の path を、列挙結果や lexical containment だけでなく `assertSafeRepositoryPath` へ接続した。symlinked package manifest は依存関係 read に到達せず、source-derived analysis へ外部 metadata を混入させない。関連 **2 files / 6 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の system actuator status／directory loader 再レビュー

system actuator の `list_missions`／`list_capabilities`／`sample_traces`／`artifact_collection` と `scan_directory` が、列挙した mission／package／trace／artifact path を直接 read していた残存を修正した。directory／leaf を `assertSafeRepositoryPath` と `safeLstat` で再検査し、symlink／非 regular file を status・capability・trace・artifact read-model へ混入させない。関連 **2 files / 1 test passed**、actuator typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: KD-03/PI-03 の worker-state journal loader 再レビュー

worker state journal の constructor 後に journal／derived index leaf が差し替わると、restore／summary の JSONL／JSON read と index write が再検証なしに進み得た残存を修正した。append、restore、self-healing projection の各操作時に `assertSafeRepositoryPath` を再適用し、symlinked worker state を fail-closed にした。関連 **2 files / 20 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: KD-02/PI-03 の manual-drive bridge resource loader 再レビュー

manual-drive bridge の descriptor／command／result／cancellation resource が初期 `bridgePaths` 解決後に差し替えられた場合、JSON／JSONL read・append・write が再検証なしに進み得た残存を修正した。durable descriptor、command queue、result journal、cancellation journal の各操作時に `assertSafeRepositoryPath` を再適用した。関連 **1 file / 17 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-16/PI-03 の writer-lease resource loader 再レビュー

writer lease の本体と metrics が初期 lease path の解決後に JSON／metrics leaf を差し替えられた場合、read／write が再検証なしに進み得た残存を修正した。lease read／write、metrics read／write、metrics path derivation の各入口を `assertSafeRepositoryPath` へ接続し、symlinked lease を fencing／observability state に混入させない。関連 **2 files / 9 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の surface／task-session／metrics resource loader 再レビュー

surface coordination の record discovery／JSON read／削除、task-session の runtime／manifest／state read、metrics の履歴／SLO read と JSONL append に残っていた operation-time path boundary を修正した。`safeStat` の symlink 追跡を `safeLstat`／`assertSafeRepositoryPath` へ置き換え、symlinked outbox／session／metrics history が外部 resource を read-model・task list・metrics ledger へ混入させないことを固定した。関連 **6 files / 48 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check`、canonical full gate **68/68** で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の governed catalog 共通 loader 再レビュー

`defineCatalog` の `load`／`generation`／`publish` が Foundation I/O へ委譲する前に catalog path を再検証していなかった残存を修正した。共通入口を `assertSafeRepositoryPath` へ接続し、symlinked catalog が cache／generation 判定／publication の入力へ混入しないようにした。関連 **2 files / 4 tests passed**、core typecheck、対象 lint、Prettier、`git diff --check`、canonical full gate **68/68** で確認した。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全件 inventory は継続課題である。

## 2026-08-31: PI-03 の intent trace／Nexus／管理 CLI direct loader 再レビュー

intent trace の trace／audit JSONL discovery、Nexus daemon の常駐 JSON／runtime session、control-plane／knowledge／workflow registration CLI の catalog・proposal path を操作時の `assertSafeRepositoryPath` へ接続した。symlink／repository 外 resource は証跡 read-model、常駐 dispatch、管理 catalog の read／write に到達せず、Nexus の runtime session 列挙も regular directory／file に限定した。関連 **5 test files / 7 tests passed**、typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe、未監査 direct loader 全件 inventory、全 script harness／generator 移行は継続課題である。

## 2026-08-31: PI-03 の egress／TaskScenario smoke loader 再レビュー

egress warn report の caller 指定 audit directory／JSONL leaf と TaskScenario smoke の scenario／generated profile path を操作時の `assertSafeRepositoryPath`／`safeLstat` へ接続した。repository 外・symlink・非 regular file は運用 report の read と smoke fixture の read／write に到達せず、egress report は不正な1 leaf を skip して安全な観測を継続する。関連 **4 test files / 5 tests passed**、typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe、未監査 direct loader 全件 inventory、全 script harness／generator 移行は継続課題である。

## 2026-08-31: PI-03 の Chronos trace feed loader 再レビュー

Chronos の trace feed／detail read-model が trace directory と日付形式 JSONL leaf を列挙時に再検証していなかった残存を修正した。`assertSafeRepositoryPath`／`safeLstat` によって symlink／非 regular file は tenant／tier projection 前の保存済み trace read に到達しない。関連 **1 file / 9 tests passed**、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe、未監査 direct loader 全件 inventory、全 script harness／generator 移行は継続課題である。

## 2026-08-31: PI-02/PI-03 の Chronos agent route mission projection 再レビュー

Chronos agent route の repository-wide quick-action mission projection が動的 core facade に存在しない `loadJson` を参照していた runtime defect を修正し、`readJson`／`assertSafeRepositoryPath` へ統一した。mission／NEXT_TASKS／PLAN の path を列挙・read 前に再検証し、malformed／symlink entry は単一 mission 単位で除外して他の projection を継続する。関連 **3 test files / 36 tests passed**、typecheck、対象 lint、Prettier、`git diff --check` で確認した。provider CLI の実 OS-level enforcement probe、未監査 direct loader 全件 inventory、全 script harness／generator 移行は継続課題である。

## 2026-09-01: PI-03 の Wisdom actuator direct loader 再レビュー

Wisdom actuator の `knowledge_inject`／`knowledge_export`／`knowledge_import`／reconcile が path resolver の返却値だけで source、package、destination、strategy の read／write へ進み得た残存を修正した。各 operation-time path を `assertSafeRepositoryPath` へ接続し、入力 leaf は `allowMissingLeaf` で boundary／symlink component を先に検査したうえで、従来の missing-resource／schema error semantics を維持する。

検証: Wisdom actuator **4 files / 44 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の system actuator focused-target／reconcile path 境界

system actuator の focused-target store と reconcile strategy が module-level／resolver-derived path を operation-time に再検査せず read／write へ進み得た残存を修正した。focused target の保存・復元と strategy の missing semantics を維持し、`assertSafeRepositoryPath` によって symlink／repository 外 resource を fail-closed にした。

検証: system actuator **5 files / 100 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の meeting browser cookie resource 境界

meeting browser driver の cookie store が account slug を path segment として検証せず、resolver-derived credential path を read／write していた残存を修正した。slug を単一 safe path segment に限定し、cookie file と parent directory を operation-time の `assertSafeRepositoryPath` で再検査する。

検証: meeting browser driver **1 file / 22 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の meeting actuator consent resource 境界

meeting actuator の `checkSpeakConsent` が mission evidence path を resolver の返却値だけで `safeExistsSync`／`loadJson` へ渡していた残存を修正した。`voice-consent.json` を read 前に `assertSafeRepositoryPath` で再検査し、missing／malformed／expired consent の既存 semantics を維持しながら symlink／repository 外 evidence を fail-closed にした。

検証: meeting actuator **4 files / 21 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の browser runtime resource 境界

browser actuator の session metadata、CDP marker、action trail、approval、snapshot、operator continue が helper 内で直接 resource path を組み立てていた残存を修正した。operation-time の `assertSafeRepositoryPath` と session-derived filename の単一セグメント正規化を追加し、repository 外・symlink 経由の runtime resource を read／write／poll へ到達させない。

検証: browser actuator **4 files / 43 tests passed**、対象 lint、Prettier、`git diff --check`、canonical full gate **68/68 passed**。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の browser passkey catalog 境界

browser actuator の passkey provider catalog が resolver の返却値を直接 `loadJson` へ渡していた残存を修正した。catalog read 前に `assertSafeRepositoryPath` を再適用し、symlink／repository 外 catalog は既存の provider fallback へ到達せず fail-closed にした。

検証: browser actuator **2 files / 44 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の working-memory period path 境界

working-memory の daily／weekly period key が personal journal／weekly path のファイル名へ直接連結されていた残存を修正した。日付の実在性と ISO week key を検証し、sidecar／index／personal resource も operation-time の `assertSafeRepositoryPath` で再検査する。

検証: working-memory **2 files / 9 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の deployment adapter config 境界

deployment adapter の既定 personal config path が resolver の返却値だけで JSON read へ進み得た残存を修正した。環境由来の explicit path と同じ `assertSafeRepositoryPath` を default path にも適用し、symlink／repository 外 config を adapter 設定へ混入させない。

検証: deployment adapter **3 files / 14 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の direct loader 残存再レビュー

orchestrator の bundle template、code の skill index、Android UI defaults、media document layout catalog に残っていた resolver 結果の直接 read を修正し、読み込み直前に `assertSafeRepositoryPath` を適用した。ジョブ由来の repository 外 template と既定 catalog の symlink／非境界 path を fail-closed にする。

検証: 対象 actuator **7 files / 126 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の OAuth／plugin pack loader 境界

OAuth の state 未指定セッション読み込みと plugin pack の manifest discovery に残っていた symlink／非 regular file の直接 read を修正した。`assertSafeRepositoryPath` と `safeLstat` を read 前に適用し、credential と untrusted pack metadata の境界を fail-closed にする。

検証: OAuth／plugin pack **2 files / 19 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の mission process planning artifact 境界

mission process planning の `NEXT_TASKS.json`、gate definitions／records、`TASK_BOARD.md` が mission root 検証後に child path を直接組み立てていた残存を修正した。operation-time の `assertSafeRepositoryPath` を各 artifact へ適用し、symlink／repository 外 process artifact の read／write／gate evaluation を fail-closed にする。

検証: mission process planning **2 files / 16 tests passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の kyberion_home procedure inspect trust 境界

`kyberion_home procedure inspect` が desktop pipeline のロード時に `trustResolved: true` を無条件指定していた残存を修正した。未承認の project-local pipeline は inspection でも trust boundary を越えず、既存の blocked／repair guidance を維持する。

検証: kyberion home trust boundary **1 file / 1 test passed**、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の skill plugin trust-input 境界

`.kyberion-plugins.json` と plugin manifest を parse する前に `safeLstat` で trust input 自体を検査し、symlink 経由で別 resource を読む経路を fail-closed にした。プロジェクト外の正当な設定は引き続き許容する。

検証: skill plugin loader **1 file / 14 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の capability broker pin path 境界

`MISSION_ID` から組み立てる mission／shared provider pin path を read／write 前の `assertSafeRepositoryPath` へ接続し、traversal-shaped mission ID が repository 外の pin resource に到達しないようにした。

検証: capability broker **1 file / 5 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の intent snapshot evidence path 境界

mission evidence 配下の intent snapshot／delta／scope-change JSONL path を read／append 前の `assertSafeRepositoryPath` へ接続し、symlink evidence directory を経由する履歴 resource を fail-closed にした。

検証: intent snapshot store **1 file / 11 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-05 の provisioned receipt replay recovery

provisioned receipt の `provisioned`／`verified` 対を pure reducer で検査し、未検証 receipt が残る replay plan は `recovery_required` を返して orchestration の自動再実行を停止するようにした。orphaned verification も corruption として拒否する。

検証: mission orchestration journal **1 file / 10 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。全 worker 成果物の record→write→verify 接続と手動 `reconcile-work` への自動分岐は継続課題である。

## 2026-09-01: PI-05 の resume recovery scaffold

未検証 provision receipt を検出した `mission_controller resume` が、既存 scaffold を再利用しながら `reconcile-work` の operator-editable scaffold を自動生成するようにした。manifest の apply は引き続き human-gated とする。

検証: mission maintenance **1 file / 11 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。全 worker 成果物の record→write→verify 接続と manifest apply の自動分岐は継続課題である。

## 2026-09-01: PI-05 の残存 writer 接続

process-template planner、reconcile-work 適用、requested task recovery の `NEXT_TASKS.json`／gate／task board writer を共通の provisioned receipt + fenced write + reread verify へ移行した。native artifact shape と既存の再計画・再発行 semantics は維持する。

検証: process planning／task recovery **2 files / 18 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。任意 worker deliverable の全 writer 棚卸し、resume 全体の欠落検出、manifest apply の自動分岐は継続課題である。

## 2026-09-01: PI-15 task recovery の scope 解決

task recovery の `NEXT_TASKS.json` は public 固定ではなく、既存 mission の tier／current tenant path を優先して解決し、その mission root を provisioned receipt writer の lease 境界へ渡すようにした。tenant／tier mismatch と path component 差し替えを fail-closed にする。

検証: mission task recovery **1 file / 1 test passed**、typecheck、対象 lint、Prettier、`git diff --check`。

## 2026-09-01: PI-05 の verified artifact 欠落検出

replay 前に target ごとの最新 verified receipt の mission-local artifact を再読し、消失は recovery-required として scaffold 導線へ、改変・読取不能・scope 外は `MISSION_LOG_CORRUPT` として自動 replay を停止するようにした。更新型 artifact の古い receipt は履歴として保持し、最新 receipt のみを現行状態と比較する。recovery observation には missing receipt 件数も反映する。

検証: journal **11 tests**、maintenance／worker **40 tests**、typecheck、対象 lint、Prettier、`git diff --check`。receipt 対象外の shared artifact と manifest apply の自動分岐は継続課題である。

## 2026-09-01: PI-14 の承認後 manual action resume

承認待ちで停止した durable manual command を、元 command と関連付けた新しい command として一度だけ再開できるようにした。再開時も worker の approval gate を再評価し、承認の付与や action binding の省略は行わない。Chronos の `manual_resume` と AgentPanel の Resume 操作まで同じ wire 契約へ接続した。

検証: bridge／Chronos API／入力契約 **4 files / 56 tests passed**、`build:packages`、typecheck、対象 lint、canonical full gate **68/68**。supervisor の正式な restart/recovery ceremony は継続課題である。

## 2026-09-01: PI-05 の dispatch artifact writer 接続

ticket／work-item dispatch の manifest、`NEXT_TASKS.json`、reflection、外部 ticket payload、artifact-review projection を共通 provisioned receipt writer へ接続した。native JSON shape は保持し、replay 時に dispatch artifact の欠落・改変を検出できる前提を揃えた。

検証: 関連 **5 files / 58 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`、`build:packages`。任意 worker deliverable の全 writer 棚卸しと manifest apply の自動分岐は継続課題である。

## 2026-09-01: PI-08 の承認後 pipeline resume 接続

`core:await_decision` の approval record に durable pipeline run ID を追加し、承認決定後に suspended journal と approval の scope／step／correlation を再照合してから canonical runner を managed process として起動する adapter を追加した。照合できない承認や終了済み run は fail-closed で自動起動しない。

検証: pipeline approval／run journal／approval store **4 files / 82 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。全 surface の実運用 adapter と supervisor の正式な restart/recovery ceremony は継続課題である。

## 2026-09-01: mission worker restart/recovery ceremony 接続

`mission_controller resume` が専用の durable `mission_worker_recovery_requested` event を発行し、detached mission-orchestration worker が `paused` goal journal と task scope を再検証してから goal driver の明示 resume を実行するようにした。provider runtime supervisor が担当する runtime prewarm／管理とは分離し、provision recovery blocked 時と rapid resume の重複は no-op にする。

検証: 関連 **5 test files / 44 tests passed**、typecheck、対象 Prettier、`git diff --check`。

## 2026-09-01: PI-15 の recovery scope 再レビュー修正

上記 recovery event が `NEXT_TASKS.json` と graph journal を `public` 固定で探していたため、confidential／tenant mission の paused goal が存在しても no-op になる残存を修正した。既存 mission の解決済み tier／tenant root を progress controller、dispatch preflight、graph journal の read／write／lease 境界で共有し、confidential mission の回帰を追加した。

検証: 関連 **2 files / 8 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`、package build、canonical full gate **68/68**。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03/PI-15 の mission orchestration scope 再監査

同じ public 固定参照が phase-exit gate、worker の review diff／task result／clarification、coordination bus、process-template reader に残っていたため、既存 mission の解決済み tier／tenant root を各 read／write／lease 境界で利用するよう修正した。confidential mission の gate／bus／planner／worker evidence 回帰を追加し、public mission の既存 path boundary も維持した。

検証: 関連 **6 files / 45 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`、package build。canonical full gate はこの後の docs 更新を含めて再実行する。provider CLI の実 OS-level enforcement probe と未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-05 の team composition writer 再監査

planner の team-composition plan／brief が native JSON を直接書いていた残存を、共通の provisioned receipt + fenced write + reread verify へ移行した。保存時の native JSON shape と既存の plan／brief 読み込み semantics は維持し、receipt の verified target を回帰で確認した。

検証: team composition **2 files / 13 tests passed**、対象 lint、Prettier、`git diff --check`、typecheck、package build。任意 worker deliverable の全 writer 棚卸し、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03/PI-05/PI-15 の worker scope／成果物 writer 再監査

worker の prompt／context provisioning、goal journal、acceptance gate、draft refine、clarification／best-of／PR evidence が public 固定 root または暗黙の journal root を使う残存を修正した。既存 mission の tier／tenant root を優先し、明示 tenant はその scope に固定する。mission 外 deliverable は読む前に拒否し、clarification／alternative／PR artifact も解決済み root の receipt writer へ接続した。

検証: 関連 **8 files / 77 tests passed**、対象 lint、typecheck、Prettier、`git diff --check`、`build:packages`、canonical full gate **68/68**。manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe、未監査 direct loader 全体 inventory は継続課題である。

## 2026-09-01: PI-03 の direct loader inventory 再監査

intent trace の mission／trace JSONL、Google Workspace payload-file、CLI の mission／app profile resource、actuator の capability／example／playground manifest discovery に read 前の repository／symlink 境界検査を追加した。安全でない候補は取り込まず、既存の discovery／fallback semantics を維持した。

検証: 関連 **11 files / 12 tests passed**、対象 lint、typecheck、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の mission alignment approval loader 再監査

alignment approval の要求・判定・brief surface が解決済み mission path を操作時に再検査せず、brief の存在確認／JSON read へ進める残存を修正した。`assertSafeRepositoryPath` を3入口へ接続し、brief leaf／親 component の symlink と repository 外 path を fail-closed にした。既存の no-request／missing／drifted semantics は維持した。

検証: 関連 **3 test files / 18 tests passed**、typecheck、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の virtual office mission discovery 再監査

virtual office の mission discovery が列挙した directory／`mission-state.json` を操作時に再検査せず、symlink mission が dashboard read-model へ混入し得る残存を修正した。root、mission directory、state leaf を `assertSafeRepositoryPath`／`safeLstat` で確認し、不正候補は skip して既存の表示 semantics を維持した。テストfixtureの不足していた process-definition registry も最小限補った。

検証: virtual office **1 file / 5 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の facet evaluation fixture discovery 再監査

`eval/facets` の fixture discovery が列挙結果を直接 JSON read していた残存を修正した。fixture root、各 JSON leaf、regular-file 種別を操作時に `assertSafeRepositoryPath`／`safeLstat` で確認し、symlink fixture は評価入力へ混入させず安全な fixture の処理を継続する。

検証: facet loader **1 file / 1 test passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の mission journal discovery 再監査

mission journal の directory 列挙が symlink mission と state leaf を直接 JSON read していた残存を修正した。search root、mission directory、`mission-state.json` を操作時に `assertSafeRepositoryPath`／`safeLstat` で確認し、不正候補は履歴表示へ混入させず継続する。

検証: mission journal **1 test passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の config mission path boundary 再監査

config mission の tenant／instance identifier と preset manifest discovery が lexical path のまま resource read／write へ進み得た残存を修正した。config mission root、brief path、preset leaf を `assertSafeRepositoryPath`／`safeLstat` へ接続し、traversal・symlink・非 regular file を fail-closed にした。

検証: config mission **1 test passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の soak restart root 境界

`soak_restart_e2e --root` が caller の root を cleanup／state write／worker引数へ直接渡していた残存を修正した。root と daemon heartbeat／journal／provider state leaf を operation-time の `assertSafeRepositoryPath` で再検査し、repository 外・symlink 経由の削除／書込みを開始前に拒否する。

検証: soak restart **1 file / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の sovereign dashboard discovery 再監査

sovereign dashboard の runtime doctor／active mission／connection discovery が列挙結果を直接 state／JSON read へ渡していた残存を修正した。root、directory、state／JSON leafを `assertSafeRepositoryPath`／`safeLstat` で操作時に検査し、symlink mission／connectionを dashboard read-model へ混入させない。

検証: sovereign dashboard **1 file / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の mission alignment reviewed-resource reader 再監査

`read-decision` が caller の reviewed HTML／brief JSON path を直接存在確認・readしていた残存を修正した。両入力を `assertSafeRepositoryPath` で解析前に再検査し、repository 外・symlink resource を承認判断の入力へ混入させない。

検証: read-decision **1 test passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の software quality artifact reader 再監査

software quality report の contract／inventory／execution reader と report／defect output が caller pathを直接扱っていた残存を修正した。入力・出力を `assertSafeRepositoryPath` で統一し、repository 外・symlink経由の品質証跡 read／writeを fail-closed にした。

検証: software quality **1 file / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の work coordination／Slack kickoff input reader 再監査

work coordination の再帰mission scanとSlack kickoff互換CLIが、列挙・caller指定のJSON pathを直接 readしていた残存を修正した。mission root／child／state leafとissue／job inputを `assertSafeRepositoryPath`／`safeLstat` へ接続し、repository 外・symlink resourceを履歴・dispatch入力へ混入させない。

検証: work coordination／Slack kickoff **2 test files / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の soak endurance resource boundary 再監査

`soak_endurance` の caller 指定 `samplePaths`／`reportPath`／`metricsDir`／`evidenceDir` と metrics filename が、repository 外または symlink 経由の resource を read／write／cleanup へ渡し得る残存を修正した。各 path を harness 開始時と実 I/O 直前に再検査し、sample は regular file のみを採用、metrics filename は単一安全セグメントに限定した。repository 外・symlink・traversal の回帰を追加した。

検証: soak endurance **1 test file / 8 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の mission brief renderer resource boundary 再監査

`mission-alignment-gate/render-brief` の caller 指定 brief JSON／HTML output が、repository 外または symlink 経由の resource を read／write へ渡し得る残存を修正した。入力は regular file を確認してから JSON read し、既定・明示 output も `assertSafeRepositoryPath` で write 前に再検査する resolver と境界回帰を追加した。

検証: render brief **2 test files / 3 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の onboarding identity input reader 再監査

`onboarding_apply --identity` の caller 指定 JSON path が、repository 外・symlink・非 regular file を `safeExistsSync`／`readJson` へ渡し得る残存を修正した。入力 resolver と regular-file 検査を read 前へ追加し、既存の missing-file guidance を維持した。

検証: onboarding input **1 test file / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の voice profile reader 再監査

`voice_upgrade` の active voice profile が、resolver で解決済みでも symlink／非 regular file のまま既存 profile の JSON read／tier write へ到達し得る残存を修正した。profile resource を read／write 前に repository／symlink 境界へ接続し、境界 resolver の回帰を追加した。

検証: voice profile **1 test file / 2 tests passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の contract schema shared catalog loader 再監査

contract-schema checker の governance／surface／service／agent／voice catalog discovery が、列挙した JSON leaf を直接 `readJson` へ渡していた残存を修正した。共通 helper で directory／leaf を `assertSafeRepositoryPath`／`safeLstat` に通し、symlink・非 regular file・repository 外 resource を schema check 入力から除外する。

検証: contract schema loader **1 test passed**、対象 lint、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-01: PI-03 の First-Win lifecycle smoke reader 再監査

First-Win lifecycle smoke の live identity、schedule pipeline、dry-run fixture read を `assertSafeRepositoryPath`／`safeLstat` へ接続した。repository 外・symlink・非 regular file の identity／pipeline は live acceptance／schedule validation の read へ到達しない。

検証: First-Win lifecycle **3 files / 16 tests passed**、対象 lint、typecheck、Prettier、`git diff --check`。未監査 direct loader 全体 inventory、manifest apply の自動分岐、provider CLI の実 OS-level enforcement probe は継続課題である。

## 2026-09-06: PI-13／DH-11 の script integrity CLI 接続

script integrity checkerをroot `package.json` の `check:script-integrity`へ登録した。共通 `defineScript`／`defineGenerator` のentrypoint監査は本体実装だけでなく、開発者とCIが同じ正規package scriptから再実行できることを受入条件とし、harness移行漏れを手動コマンドに依存させない。

検証: `pnpm run check:script-integrity`、checker **1 file / 7 tests passed**、Prettier。provider CLIの実OS-level enforcement probeと未監査direct loader全体inventoryは継続課題である。

## 10. 検証コマンド(実装時)

- DH-01: `pnpm vitest run libs/core/op-preflight.test.ts libs/core/op-preflight-defaults.test.ts` + `pnpm check -- --scope full --only op-preflight-coverage`
- DH-02: `pnpm vitest run libs/core/seam.test.ts` + 各 seam の移行テスト、`grep -c "export function reset" libs/core/*.ts` の減少をラチェット
- DH-03/07: `pnpm bindings --dump --json`、`pnpm kyberion generate capability-seams && pnpm check -- --scope full --only capability-seams`
- DH-06: `pnpm check -- --scope full --only module-invariants`
- DH-08: `pnpm plugin:install` → deactivate → 全貢献消失の boundary test

## 11. 関連

- [PI_ADOPTION_PLAN_2026-08-16](./PI_ADOPTION_PLAN_2026-08-16.ja.md)(PI-08 preflight repair ↔ DH-01、PI-09 provenance/narrow-only ↔ DH-08、PI-10/13 ↔ DH-04、PI-15/16 ↔ DH-10/12)
- [TAKT_ADOPTION_PLAN_2026-08-16](../improvement-plans-archive/2026-08/TAKT_ADOPTION_PLAN_2026-08-16.ja.md)(TK-04 facet ↔ DH-09、TK-03 ↔ DH-10)
- [QM_ADOPTION_PLAN_2026-08-01](../improvement-plans-archive/2026-08/QM_ADOPTION_PLAN_2026-08-01.ja.md)(QM-06 backend 能力宣言 ↔ DH-04、QM-07 skill pack ↔ DH-08)
- [KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16](./KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)(KO-06 `pnpm scope` ↔ DH-03)
- `knowledge/product/governance/adapter-first-extension-policy.md`(4 層規則、DH-02 の土台)
- `knowledge/product/governance/kyberion-development-practices.md`(登録儀式、DH-07 の流儀)
- `docs/developer/EXTENSION_POINTS.md` / `plugins/README.md`(DH-08 で更新対象)
