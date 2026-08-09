# 成果物とエージェントのライフサイクル統治 — スコープ別保持と NHI レジストリ(AL-01〜04・NI-01〜05)

> **作成日**: 2026-07-26
> **優先度**: P0(AL-01)/ P1(AL-02・AL-03・NI-01・NI-02)/ P2(AL-04・NI-03・NI-04・NI-05)
> **位置づけ**: ストレージ面は [KM-01(揮発メモリ活性化)](./KM-01_VOLATILE_MEMORY_ACTIVATION.ja.md)・[KM-04(ナレッジストア衛生)](./KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md)の後続で、点在する TTL・janitor を「スコープ別ライフサイクル」へ体系化する。識別面は [AO-05(Agent・Persona・組織モデル)](./AO-05_AGENT_PERSONA_ORGANIZATION_MODEL.ja.md)の概念分解と [CO-06(AI Workforce)](./CO-06_SOLOPRENEUR_AI_WORKFORCE.ja.md)の accountable_human_id / delegation lease 語彙を前提に、**未実装のまま残っている「永続的なエージェント識別と台帳」**(NHI = Non-Human Identity)を実装する。[AA-03(A2A 識別と信頼)](./AA-03_A2A_IDENTITY_TRUST.ja.md)の署名基盤を拡張するが、公開鍵 per-agent 署名(E4)は扱わない。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

本計画は独立だが同根の2欠陥を扱う。根は同じ — **tenant → project → mission → task → session というスコープ階層が、アクセス制御(tier-guard)と配置(path-resolver)には存在するのに、「いつまで存在するか」(保持)と「誰であるか」(識別)には接続されていない**。

- **AL(Artifact Lifecycle)**: artifacts は書かれた後のライフサイクルが未定義。ミッション finish は成果物を一切整理せず、自動アーカイブは ADF パス誤りで**事実上死んでいる**。`active/shared/tmp/` 直書きが非テスト 63 箇所あり、その 24h TTL janitor も実際には回っていない(7/6〜7/8 のファイルが残存)。`runtime/` 43 サブディレクトリ中 TTL があるのは 3 つのみ。→ **宣言的な保持カタログ(スコープ × クラス → TTL/archive)を正本化し、GC をスコープのライフサイクルイベント(task 完了・mission finish/archive・tenant オフボード)に連動させる。**
- **NI(NHI = エージェント識別)**: エージェントの表現が `agentId`(in-memory)/ role 文字列 / persona / provider / `peer_id` / `resource_id` の**6系統に分裂**し、正準の永続 identity が無い。`owner_actor` や `holder_peer_id` は**検証されない自由文字列**で、trace モデルには actor 帰属フィールドが無く、schema 上存在する `runtime_identity` は本番経路で**常に null**。→ **journal-backed の永続 AgentIdentity レジストリ(ライフサイクル状態・所有者帰属・スコープ所属)を1本立て、actor 文字列をそこへ接続し、委譲チェーンとタスク粒度短命グラントを刻印する。** これは 2026 年時点の NHI 管理の業界合意(§2)への将来対応でもある。

```
      スコープ階層(既存: 配置 + アクセス制御)     本計画が接続する2面
  tenant_slug ─ organization_id ─ project ─ mission ─ task ─ session
        │                                   ├─ AL: 保持(retention catalog + スコープ連動 GC)
        │                                   └─ NI: 識別(AgentIdentity の所属・ライフサイクル)
```

包含順の正本は [`entity-scope-hierarchy.md`](../../../knowledge/product/architecture/entity-scope-hierarchy.md) である。

## 1. 診断(2026-07-26、実コード突合)

### 1.1 保持: スコープはアクセス制御にあるが保持には無い

- `libs/core/path-resolver.ts` はスコープ別配置を既に持つ(`volatile(scope, ref)` `:86-138` が session / mission / project / tenant / personal / global を別ディレクトリへ)。`libs/core/tier-guard.ts` は tenant / project / tier のアクセス制御を fail-closed で強制する(`checkTenantScope` `:302-387` 等)。**しかしどちらも「いつ消すか」を知らない。**
- 保持機構は `libs/core/storage-janitor.ts` のみ: tmp 24h(`:14`)、logs 30d(`:15`)、`runtime/` は 43 サブディレクトリ中 **3 つだけ**名指しの TTL(`RUNTIME_RETENTION` `:25-29`)。`runtime/reports/`(108 件)・`runtime/artifacts/`(52 件)・`runtime/distill-candidates/`(~97 件)・`exports/`・mission ディレクトリ・`archive/` は**無保持**。
- TTL 値がコード内定数に散在し、governance 文書に保持ポリシーの正本が無い(KM-01/KM-04 は範囲が狭い)。

### 1.2 保持: 既存 GC が2箇所で実質死んでいる

- **ミッション自動アーカイブは dead path**: `libs/core/mission-maintenance.ts::purgeMissions`(`:863-945`)は ADF を `knowledge/governance/mission-lifecycle.json` から読むが、実在するのは `knowledge/product/governance/mission-lifecycle.json`。「ADF not found」で early return し、**max_age_days:30 のアーカイブは一度も動いていない**。
- **janitor が実際に回っていない**: `active/shared/tmp/` に 261 エントリ、うち 24h TTL を大幅超過した 7/6〜7/8 のファイルが残存。cron(`pipelines/storage-janitor.json`、JST 4:30)は chronos daemon / baseline-check 提出に依存するが、稼働鮮度を観測する層が無く、止まっていても誰も気づかない。
- ミッション `finish`(`mission-lifecycle.ts:1160`)はゲート評価と状態遷移のみで、**ミッションツリー・per-mission git repo・evidence の整理を一切しない**。mission-hygiene(`libs/core/mission-hygiene.ts:11-20`)は明示的に detect-only。

### 1.3 保持: tmp-by-default 習慣

- `sharedTmp()` の非テスト呼び出し **63 箇所**(テスト込み 213)。大出力退避(`output-artifacts.ts:71-74` → `active/shared/tmp/tool-output/`)、mission seal の暗号化物(`mission-seal.ts:31-34`)、janitor レポート自身までが tmp 行き。ミッション成果と消耗品が同じ「24h で消える(はずの)床」に混在し、スコープ(このファイルは誰の・どの仕事のものか)が配置から失われる。

### 1.4 識別: エージェントの正準 identity が存在しない

- 表現が6系統に分裂: (a) `agent-registry.ts` の `AgentRecord`(**in-memory Map のみ**、`:28-29` — 再起動で全消失)、(b) `agent-manifest.ts` の宣言 manifest、(c) `authority.ts::resolveRole` は **env とプロセス名から role 文字列を推定**(`:177-188`)、(d) mission-state の `assigned_persona`、(e) `work-coordination.ts` の `actorPeerId` / `holder_peer_id`(**無検証の自由文字列**)、(f) `mission-team-binding.ts` の `resource_id`。相互の対応表が無い。
- `orchestrator-session.ts` の `owner_actor`(`:479`)も呼び出し側が名乗るだけの文字列。**リースの排他は効くが、「そのリースを持つのが誰(何)か」は誰も検証しない。**
- `runtime_identity` フィールドは 4 schema + 2 core interface に定義済みだが、本番経路では**常に null**(`mission-team-binding.ts:157,288`。非 null はテストフィクスチャの `'stripe-prod'` のみ)。
- trace モデル(`libs/core/src/trace.ts:42-51`)の metadata は missionId / correlationId / actuator / tenantSlug のみで **actor 帰属フィールドが無い**。A2A 署名(AA-03)は same-host 共有秘密の完全性保証であり、per-agent の識別ではない(文書に明記済みの既知限界)。
- ライフサイクルも無い: spawn→shutdown はプロセス寿命の話で、「このエージェント identity はいつ生まれ、誰が所有し、いつ退役したか」の台帳・監査が存在しない。ミッションが終わってもそのミッション所属のエージェント概念は**孤児として残らない(そもそも記録されない)**。

### 1.5 概念的な足場は既にある(実装だけが無い)

- AO-05 が identity の8概念分解(agent_profile / authority_role / organization_role / team_role / perspective / …)と「provider/model は identity ではない」を確立済み。
- CO-06 が actor-neutral な `WorkforceResourceRef`(`resource_type: agent|human|service`、`status: active|suspended|revoked`)と **agent/service への `accountable_human_id` 必須**(`mission-team-binding.ts:167-171` で throw)、bounded delegation lease の語彙を定義済み。
- SO-02 が journal-backed event sourcing による永続レコード(OrchestratorSession)の実装パターンを確立済み。NI-01 はこの型をそのまま使う。

## 2. NHI 外部動向(2026-07 時点)と設計原則

計画の将来対応性の根拠。実装はこれらへの**依存ではなく写像可能性**(projection seam)として設計する。

- **OWASP Non-Human Identities Top 10(2025)**: NHI リスクの正典。#1 は Improper Offboarding(退役処理不備)、他に過剰権限・長寿命秘密・identity 再利用・人間による NHI 借用(帰属破壊)。**リスクの大半が「台帳・所有者・退役規律の不在」の症状**という整理。→ NI-01/NI-05 の直接の根拠。
- **標準**: SPIFFE/SPIRE(attestation ベースの workload identity、安定 URI 形式 ID)と IETF WIMSE WG(architecture/identifier/workload-creds ドラフト進行中)。OAuth 2.1 + **RFC 8693 Token Exchange**(ネスト `act` claim = 委譲チェーンの標準形)+ **RFC 8707 Resource Indicators**(audience 拘束)。Transaction Tokens は WG Last Call。→ NI-03 の委譲チェーンと NI-04 の audience 拘束は、この語彙と同型の内部版として設計する。
- **エージェント固有**: Microsoft Entra Agent ID(エージェントを first-class identity + blueprint + ライフサイクルガバナンス、秘密なし FIC 認証)が商用の最完成形。MCP authorization は OAuth 2.1 + RFC 8707 を必須化。Google A2A の既知ギャップは「Agent Card が自己申告で attestation 不在・委譲に権限検証と監査が無い」— **Kyberion 内部で同じ穴(無検証 actor 文字列)を放置しない**根拠。OpenID AIIM CG / W3C Agent Identity Registry CG がレジストリ標準化を開始。
- **導出する設計原則(耐久性のある 5 点)**: (1) 所有者帰属つきの安定エージェント ID、(2) ライフサイクル状態を持つレジストリと強制的な退役、(3) タスク粒度・短命・audience 拘束の権限グラント、(4) user→orchestrator→worker→sub-worker の明示的委譲チェーン監査、(5) 外部標準(SPIFFE 風 URI・`act` チェーン)へ写像可能な内部モデル。

## 3. 目標アーキテクチャ

1. **スコープ階層は1つ、消費面は4つ**: tenant → project → mission → task → session の同一階層を、配置(path-resolver)・アクセス制御(tier-guard)・**保持(retention catalog)**・**identity 所属(AgentIdentity.affiliation)**が共有する。新しい階層は発明しない。
2. **保持は宣言、削除はイベント連動 + TTL の二本立て**: `storage-retention-catalog`(governance 配下の正本)が「スコープ × 成果物クラス(evidence / report / export / cache / tmp)→ TTL・archive 先・監査要否」を宣言する。janitor はカタログ駆動の TTL 掃除、ライフサイクルイベント(task 完了 / mission finish / mission archive / tenant オフボード)は該当スコープの即時整理を行う。**未宣言ディレクトリは黙認せず表面化する**(AR-06 no-silent-noop と同思想)。
3. **識別は AgentIdentity 1本に正準化**: `nhi_id`(`kyberion://agent/<org>/<slug>` の URI 形式)を持つ journal-backed 永続レコード。所有者(`accountable_human_id`)・所属スコープ・ライフサイクル状態(provisioned → active → suspended → retired)・trust 参照を持つ。既存の6系統(agentId / role / persona / peer_id / resource_id / provider)は**このレコードの属性または射影**であり、provider/model は identity ではない(AO-05 踏襲)。
4. **権限は identity にではなくタスクに付く**: 常設権限を増やさず、task contract 実行時に発行される短命グラント(grantee = nhi_id、audience = mission/task、expires_at 必須)で最小権限を実現する。
5. **帰属は全ホップで独立検証可能**: work-item claim・orchestrator session・A2A・trace・execution ledger のすべてが nhi_id と委譲チェーンを刻印し、「誰の代理で誰が何をしたか」を監査から復元できる。
6. **段階導入は warn → enforce**(AA-03 と同じ移行方式)。既存の無登録 actor を一括で止めず、観測期間を挟んで単独コミットで enforce へ切り替える。

## 4. 実装タスク

### AL-01: 保持カタログの正本化と既存 GC の実効化

> 優先度 P0 / 規模 S〜M / 依存: なし

まず死んでいるものを動かし、散在する定数を正本へ集める。

1. **purgeMissions の dead path 修正**: `mission-maintenance.ts` の ADF 読込を `knowledge/product/governance/mission-lifecycle.json` へ訂正し、実 ADF での hermetic テスト(30日超過ミッションが archive へ移動)を追加する。ADF 不在時は early return ではなく ops-alert(no-silent-noop)。
2. **janitor 稼働の観測**: `runtime/state/janitor-last-run.json` の鮮度を baseline-check のレイヤへ追加(48h 超で `needs_attention`)。janitor 実行レポートに「スキャン対象 / 削除件数 / **未宣言のためスキップしたディレクトリ一覧**」を含める。
3. **retention catalog の正本化**: `knowledge/product/governance/storage-retention-catalog.json`(+ schema)を新設し、既存の散在定数(`DEFAULT_TMP_TTL_MS`・`LOG_RETENTION`・`RUNTIME_RETENTION`・mission-lifecycle ADF の `max_age_days`)を**現行値のままカタログ駆動へ置換**する(挙動不変から開始)。カタログの語彙: `{ path_pattern | scope, artifact_class, ttl_days | event, action: delete|archive|export, audit: bool }`。

**受入条件**

1. purge の実 ADF hermetic テスト(archive 移動 + 元削除 + 監査記録)。ADF 不在で ops-alert。
2. baseline-check レポートに janitor 鮮度が出る(stale で `needs_attention`)。
3. janitor がカタログ駆動で従来と同一挙動(既存 janitor テスト緑 + カタログ schema 検証テスト)。

— claude-sonnet-4

### AL-02: スコープ別成果物配置 API と tmp-by-default の解消

> 優先度 P1 / 規模 M / 依存: AL-01(カタログ語彙)

1. `libs/core/artifact-store.ts` を拡張し、`writeScopedArtifact({ scope: { tenant?, project?, mission?, task?, session? }, artifact_class, name, content })` を新設する。配置は path-resolver の既存正準位置(missionDir / projectWorkspaceDir / volatile)へ解決し、`artifact_class` を index(mission-local `artifacts-index.jsonl` 等)に記録して AL-03/AL-04 の GC が判定に使えるようにする。
2. **tmp 直書きの主要 3 経路を移行**: (a) `output-artifacts.ts::offloadLargeOutput` の退避先を mission-local(`<missionDir>/artifacts/tool-output/`、mission 不明時のみ従来 tmp)へ。OH-04 の宣言チャンネル除外の回帰を維持する。(b) `mission-seal.ts` の成果物(`.enc`/`.key.enc`)を archive 配下へ。(c) janitor レポートを `runtime/reports/` へ。
3. **`sharedTmp` ratchet**: 非テスト呼び出し 63 箇所を allowlist 台帳(registration ceremony 型、boundary-test と同方式)に固定し、**新規追加は CI で fail** させる。既存分は「本当に消耗品(tmp が正しい)」と「スコープ持ち成果物(移行すべき)」に分類コメントを台帳へ付し、移行は後続増分とする(本タスクでは増加ゼロの固定まで)。

**受入条件**

1. `writeScopedArtifact` のスコープ別配置 + index 記録の hermetic テスト(tenant/project/mission/task/session 各 1)。
2. 大出力退避が mission-local になり、既存 OH-04 回帰テスト緑。
3. `sharedTmp` 新規呼び出しが検知される ceremony テスト(台帳=現状 63 箇所、追加で fail)。

— claude-sonnet-4

### AL-03: ミッション finish / archive ceremony と task 成果物のクローズ

> 優先度 P1 / 規模 M / 依存: AL-01・AL-02

1. **finish 時の整理**: `mission-lifecycle-service`(SO-01 facade)の finish に retention 適用ステップを追加する。カタログと artifact_class に従い、evidence / 最終成果物 / gates / ledger は**保持**、`artifacts/tool-output/` 等の cache/tmp クラスは**削除**(削除は監査記録つき)。per-mission git repo は `git bundle` 化して evidence へ格納し、作業ツリー側の `.git` を除去する(KM-04 が指摘する nested `.git` ハザードの解消)。
2. **archive の動詞化**: `purgeMissions` を facade の `archive` 動詞へ吸収し(mission_controller CLI は thin router のまま)、`max_age_days` 経過した completed/failed ミッションを `active/archive/missions/` へ移動 + 監査記録。二重実行は冪等。
3. **task 完了時のクローズ**: task contract の完了確定点で、その task スコープの中間物(tool-output・cache クラス)を GC する(evidence 昇格済みは対象外)。

**受入条件**

1. finish→archive の hermetic E2E: クラス毎の残存/削除/bundle 化が期待どおり、削除が audit chain に記録される。
2. archive 動詞の冪等テストと、mission_controller CLI 挙動不変(既存テスト緑)。
3. task 完了 GC のテスト(evidence は残る / tool-output は消える)。

— claude-sonnet-4

### AL-04: 全域 retention カバレッジとスコープ連動 GC

> 優先度 P2 / 規模 M / 依存: AL-01〜03

1. `runtime/` 全 43 サブディレクトリ・`exports/`・`archive/` をカタログでカバーする(値はディレクトリ毎に棚卸しして宣言。判断不能なものは `review_required` として表面化し、黙って永久保持にしない)。
2. **スコープ連動 GC**: mission archive 時にその mission の session/runtime 残渣(`runtime/session/`・task-sessions 等)を GC。project / tenant の**オフボーディング動詞**(データエクスポート → 削除、human 承認必須、`cross_tenant_brokerage` と同様の監査)を新設する。
3. **削除監査と復元猶予**: カタログで `audit: true` のクラスは削除時に(what / why / policy ref)を監査へ記録し、soft-delete 猶予(`archive/.trash/` に N 日)を挟む。

**受入条件**

1. 未宣言ディレクトリゼロ(または `review_required` 表面化)を janitor レポートで確認。
2. tenant オフボードの dry-run → export → 削除 E2E(human 承認ゲート含む)。
3. 削除監査レコードと soft-delete 復元のテスト。

— claude-sonnet-4

### NI-01: 正準 AgentIdentity レコードと永続レジストリ

> 優先度 P1 / 規模 M〜L / 依存: なし(SO-02 の event sourcing パターンを流用)

1. `libs/core/agent-identity.ts` を新設: `AgentIdentityRecord { nhi_id, kind: 'agent'|'service', display_name, accountable_human_id, affiliation: { organization_id, project_id?, mission_id?, task_id? }, lifecycle_status: 'provisioned'|'active'|'suspended'|'retired', provider_hint?, model_hint?, trust_ref?, created_at, retired_at?, retire_reason? }`。`nhi_id` は `kyberion://agent/<org>/<slug>` の URI 形式(SPIFFE-ID と同型、外部写像は NI-05)。provider/model は hint 属性であり identity ではない(AO-05)。`accountable_human_id` は agent/service に必須(CO-06 の不変条件をレコード発行時に強制)。
2. 永続化は SO-02 と同型の journal-backed event sourcing(`active/shared/coordination/identity/agent-identities.jsonl`、純粋 reducer・破損行耐性 replay・governed write は execution context 検証つき)。
3. 既存系の接続: `agent-registry`(in-memory)はこのレジストリの **runtime instance cache** と位置づけ、`agent-lifecycle.spawn` で identity を発行(既存 identity への instance 紐付けも可)、shutdown で instance 解放(identity は retire まで存続)。`mission-team-binding` / `team-role-assignment-selection` の `runtime_identity` に nhi_id を実装する(**常に null の現状を解消**)。manifest の `agentId` は provisioned identity の slug として台帳と突合する。

**受入条件**

1. 発行 → active → suspend → retire の journal replay hermetic テスト(再起動相当のモジュール再ロード後も状態復元)。
2. `runtime_identity` が team-plan / staffing / execution-ledger へ貫通する(null でないことをテストで固定)。
3. agent/service で `accountable_human_id` 欠落の発行が fail-closed。nhi_id の一意性・slug 形式検証。

— claude-sonnet-4

### NI-02: actor 文字列の identity 接続と trace 帰属

> 優先度 P1 / 規模 M / 依存: NI-01

1. **claim/session の actor 検証**: `orchestrator-session` の `owner_actor`・`work-coordination` の `actorPeerId`/`holder_peer_id` を nhi_id(または registry 登録済み actor)で検証する。`KYBERION_NHI_ACTOR=warn|enforce`(既定 warn)を導入し、warn は未登録 actor を監査記録、enforce は拒否(AA-03 と同じ移行方式。enforce 切替は観測後に単独コミット)。
2. **trace への actor 帰属**: `libs/core/src/trace.ts` の metadata に `actor_nhi_id?` / `on_behalf_of?` を追加し、actuator-trace・execution ledger と同一の帰属語彙にする(OP-01 コスト集計の軸にも乗せる)。
3. **A2A の sender claim**: A2A envelope に `sender_nhi_id` claim を追加して既存 HMAC 署名(AA-03 の `a2a-envelope-signature.ts`)の署名対象へ含める。per-agent 鍵は非目標(E4)— 本タスクは「same-host 完全性の内側で送信者申告を改竄不能にする」まで。

**受入条件**

1. 未登録 actor の claim/session 作成が enforce で拒否・warn で監査記録される境界テスト。既定 warn で全既存テスト緑。
2. mission worker 経由の trace に `actor_nhi_id` が刻印される回帰テスト。
3. `sender_nhi_id` 改竄が署名検証で落ちるテスト。

— claude-sonnet-4

### NI-03: 委譲チェーンの明示化

> 優先度 P2 / 規模 M / 依存: NI-01・NI-02

1. `DelegationChain`(`[{ actor: nhi_id | 'user:<id>', team_role?, granted_scope }]` の順序付き配列、RFC 8693 のネスト `act` claim と同型)を定義し、`delegateTask` / `agent-dispatch` / A2A dispatch / task contract に貫通させる。orchestrator → worker → sub-worker の各ホップでチェーンに 1 要素追記する。
2. **attenuation 検証**: 子の `granted_scope`(capabilities / tier / write_scopes)が親を超えないことを dispatch preflight で検証する(CO-06 の delegation lease 語彙「child ≤ parent」の実装)。違反は fail-closed。
3. チェーンを execution-ledger・trace・audit chain へ刻印し、監査から full chain(発端ユーザ → 全中間 actor)を復元できるようにする。

**受入条件**

1. 2 段委譲(orchestrator→worker→sub-worker)でチェーンが 3 要素で刻印される hermetic テスト。
2. 子が親超のスコープを要求する dispatch が fail-closed になる境界テスト。
3. 監査レコードからのチェーン復元テスト。

— claude-sonnet-4

### NI-04: タスク粒度の短命グラント

> 優先度 P2 / 規模 M / 依存: NI-01(NI-03 と並行可)

1. `active/shared/auth-grants.json` の temporal grant を拡張し、`{ grantee_nhi_id, scope: { capabilities?, write_scopes?, tier_access? }, audience: { mission_id, task_id? }, expires_at, issued_by, issued_at }` の **task-scoped grant** を定義する(RFC 8707 audience 拘束の内部版: grant は宣言された mission/task の文脈外では無効)。
2. task contract の dispatch 時に発行し、task 完了・失敗・expires_at 到達で**自動収回**する(常設権限を増やさない)。`authority.resolveIdentityContext` の grant 解決を audience 検証つきに拡張する。
3. provider credential(`ANTHROPIC_API_KEY` 等)は provider-level のまま(per-agent API key は非目標)。グラントは authority/capability 層で機能する。

**受入条件**

1. audience 外(別 mission/task)での grant 行使が拒否されるテスト。
2. task 完了時の自動 revoke と expires_at 失効のテスト。
3. grant 発行・行使・収回の監査記録テスト。

— claude-sonnet-4

### NI-05: NHI ライフサイクルガバナンス(オフボーディング・棚卸し・外部写像)

> 優先度 P2 / 規模 M / 依存: NI-01・AL-03(mission archive 連動)

1. **自動オフボーディング**(OWASP NHI #1 対策): mission finish/archive 時に `affiliation.mission_id` が一致する identity を自動 retire する(AL-03 の ceremony にフック)。project / tenant オフボード(AL-04)も同様。retire 済み identity での claim/dispatch は NI-02 の enforce で拒否される。
2. **孤児検出と棚卸し**: 所属スコープが消滅したのに active な identity(孤児 NHI)を janitor / baseline-check で検出して `needs_attention` 表面化。NHI 台帳レポート(nhi_id / 所有者 / 状態 / 所属 / 最終活動)を operator packet へ追加する。
3. **外部標準への写像 seam**: `docs/developer/NHI_IDENTITY_MAPPING.md` 1 ページに、nhi_id ⇄ SPIFFE ID・DelegationChain ⇄ RFC 8693 `act`・task grant ⇄ RFC 8707 audience・lifecycle_status ⇄ Entra Agent ID governance の対応を明文化する(実装は interop が要件化した時。内部モデルが写像可能であることの検証が目的)。

**受入条件**

1. mission archive → 所属 identity 自動 retire の連動テスト。retire 済み identity の claim 拒否(enforce)テスト。
2. 孤児 identity が baseline-check で `needs_attention` になるテスト。
3. NHI 台帳レポート生成と写像文書(GLOSSARY へ NHI 用語追加、断リンクなし)。

— claude-sonnet-4

## 5. 実施順序

```
AL-01(P0: dead GC 修理 + カタログ正本)──→ AL-02(配置 API + ratchet)──→ AL-03(finish/archive ceremony)──→ AL-04(全域 + スコープ連動)
NI-01(AgentIdentity レジストリ)──→ NI-02(actor 検証 + trace 帰属)──→ NI-03(委譲チェーン)
                                   └──────────────────────────────→ NI-04(短命グラント、NI-03 と並行可)
NI-05(オフボーディング)は NI-01 + AL-03 の後(mission archive フックに依存)
AL 系と NI 系は独立に着手可。合流点は NI-05 のみ。
```

## 6. 非目標

- **OAuth AS / OIDC サーバ・外部 IdP 統合の実装**(Entra / Okta / SPIFFE への接続は NI-05 の写像文書まで。内部モデルが写像可能なら実装は要件化時で足りる)。
- **per-agent API key / provider credential の分割**(credential は provider-level のまま。XP-02 の env 最小化と矛盾させない)。
- **A2A の公開鍵 per-agent 署名**(E4 / AA-03 の残領分。NI-02 は既存 HMAC への sender claim 追加まで)。
- **`knowledge/` tier 体系・昇格ガバナンスの変更**(KM 系の領分。本計画の保持対象は `active/` 系)。
- **人間 identity の管理**(`accountable_human_id` は CO-06 の既存語彙を参照するのみ)。
- **既存 63 箇所の sharedTmp 呼び出しの全量移行**(AL-02 は増加ゼロの固定と主要 3 経路まで。残りは台帳の分類に従い後続増分)。

## 7. 関連計画

- [KM-01](./KM-01_VOLATILE_MEMORY_ACTIVATION.ja.md) / [KM-04](./KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md) — janitor と knowledge 衛生(前段)。AL はその体系化。
- [IP-14](./IP-14_REPO_HYGIENE.ja.md) — リポジトリ衛生(単発掃除)。AL は再発防止構造。
- [OP-02](./OP-02_BACKUP_RECOVERY.ja.md) — backup は `active/archive/` を対象に含むため AL-03/04 の archive 移動と整合させる。
- [AO-05](./AO-05_AGENT_PERSONA_ORGANIZATION_MODEL.ja.md) — identity 概念分解(前提)。NI はその「永続台帳」実装。
- [CO-06](./CO-06_SOLOPRENEUR_AI_WORKFORCE.ja.md) — accountable_human_id / delegation lease 語彙(前提)。NI-01/03/04 が実装面。
- [AA-03](./AA-03_A2A_IDENTITY_TRUST.ja.md) — A2A 署名基盤(NI-02 が拡張)。E4(公開鍵)は将来。
- [SO-01〜03](./SURFACE_ORCHESTRATOR_PLAN_2026-07-25.ja.md) — mission-lifecycle-service facade(AL-03 のフック点)と OrchestratorSession(NI-01 の実装パターン、NI-02 の検証対象)。
- [XP-02](./CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md) — provider credential 最小化(NI-04 の非目標境界)。
- [MO-08](./MO-08_ARTIFACT_REVIEW_CLOSURE.ja.md) — 成果物レビュー(品質面)。AL-03 の finish 整理は MO-08 の hash-bound receipt を壊さない(evidence は保持クラス)。
- [SA-01](./SA-01_AUDIT_CHAIN_INTEGRITY.ja.md) — 削除監査・チェーン刻印の記録先。
- [OP-01](./OP-01_COST_ACCOUNTING.ja.md) — actor 帰属(NI-02)がコスト集計の軸に乗る。
