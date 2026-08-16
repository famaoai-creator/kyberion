---
title: テナント導入後の Runtime・Schedule・Surface・Channel スコープ調査報告
category: Architecture
tags: [architecture, tenant, agent-runtime, schedule, surface, channel, event-scope]
importance: 9
author: Ecosystem Architect
last_updated: 2026-08-16
---

# テナント導入後の Runtime・Schedule・Surface・Channel スコープ調査報告

**調査日:** 2026-08-16
**対象:** `agent_runtime`、スケジュールタスク、surface、channel、イベント・ledger、viewer 経路
**目的:** tenant / organization の概念を導入した後も、実行要求・キュー・配信・観測の各段階で境界が失われないスコープモデルを定義する。

## 1. 結論

Kyberion の正本となる containment chain は既に次で定義されている。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

また、`libs/core/scope-context.ts` と `libs/core/event-scope.ts` に、tenant、tier、entity、viewer、NHI をまとめて検証する基盤がある。一方、今回調査した実行系の周辺では、次の三つのスコープが混在している。

1. **process scope**: supervisor daemon や surface runtime がどのプロセス所有者として動くか。
2. **request/entity scope**: どの tenant のどの organization / project / mission / task を処理するか。
3. **viewer / channel scope**: 誰がどの外部 channel または UI から見ているか。

現在は process scope が system-wide であること自体は問題ではない。しかし、そのプロセスを通過する request、結果、通知、schedule、dead-letter、メトリクスに request/entity scope が型付きで残っていないため、後段で tenant を安全に復元できない箇所がある。

したがって、推奨する基本形は次である。

> **プロセスは system または共有 tenant service として動かせるが、すべての tenant/entity 対象の request と永続レコードは、検証済みの `EventScope` 相当の scope envelope を必ず持つ。**

初期実装では supervisor / scheduler / surface runtime を tenant ごとに分離する必要はない。system-level の daemon を維持し、request 単位で scope を検証し、結果・監査・配信へ同じ scope を伝播させる方が、現在の構造に対する変更量と運用負荷が小さい。高い隔離要件がある tenant のみ、後段で process isolation を追加する。

## 2. 判定基準

| 軸             | 正本                                                        | 判定ルール                                                                                     |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Tenant         | tenant registry の `knowledge/personal/tenants/{slug}.json` | `tenant_slug` は registry に存在し active であること。`public` / `shared` 等は tenant ではない |
| Containment    | `entity-scope.ts` / `entity-scope-hierarchy.md`             | `tenant → organization → project → mission → task → session` の親子関係を崩さない              |
| Event / ledger | `event-scope.ts`                                            | 新規レコードは canonical な nested `scope` を持つ。欠落 scope を tenant と推測しない           |
| Identity       | `AgentIdentity.affiliation.tenant_slug`                     | NHI の tenant affiliation と実行 request の tenant は一致させる                                |
| Process        | runtime / surface の lifecycle manifest                     | process の owner・health・shutdown と、データの tenant scope を混同しない                      |
| Viewer         | server-side `ViewerContext`                                 | client の tenant パラメータは認可にならず、許可集合を狭めるだけ                                |
| Stance         | `customer/{slug}` / `KYBERION_CUSTOMER`                     | stance は acting-as overlay であり、containment chain の一部ではない                           |

## 3. 現在の実装調査

### 3.1 共通スコープ基盤

**できていること**

- `libs/core/scope-context.ts` が `tenant_slug`、organization / project / mission / task / session、tier、NHI、viewer principal を一つの context として検証できる。
- `libs/core/event-scope.ts` が `system` から `session` までの scope kind、authority との lineage 一致、tenant viewer の fail-closed filter を提供している。
- `knowledge/product/architecture/entity-scope-hierarchy.md` は storage、authorization、artifact、identity、event / ledger の containment chain を同じ順序で説明している。
- `customer/{slug}` を tenant とみなさない方針、tier 名を tenant とみなさない検証、tenant registry の active 判定は整備されている。

**不足していること**

- 下記の個別契約が `ScopeContext` / `EventScope` を直接持たず、flat な `mission_id` や channel 名だけで処理する経路が残っている。
- `scope` がない legacy record は system viewer では扱えるが、tenant / organization viewer が自分の tenant と推測してはいけない。この原則をすべての projection に一貫して適用する必要がある。

### 3.2 agent runtime / supervisor（調査時点）

実装上、supervisor の request / result queue は次の shared path を利用する。

```text
active/shared/coordination/agent-runtime/requests/
active/shared/coordination/agent-runtime/results/
active/shared/observability/mission-control/agent-runtime-supervisor-events.jsonl
```

`AgentRuntimeEnsureRequest` と supervisor client の ensure / ask payload は、主に `missionId`、agent、provider、model、requestedBy、runtime metadata を持つ。`AgentRecord` も `missionId` と metadata 内の `nhi_id` は持つが、tenant / organization / project が first-class field ではない。

ここで shared path を使うことは「system process scope」として許容できる。ただし次が未解決である。

- ensure / ask request に canonical な tenant / organization / project / mission / task scope が必須ではない。
- supervisor event / token metrics に mission 単位の情報はあるが、tenant scope が nested canonical scope として残らない。
- runtime spawn 時に、NHI の `affiliation.tenant_slug` と mission / request の tenant が一致することを supervisor 境界で確認する契約が弱い。
- runtime の status / snapshot が tenant/entity filter 用の scope を返さないため、operator projection が後から安全に絞り込めない。
- 手動 runtime manager の既定 provider が obsolete 化した Gemini に寄る経路があり、provider 選択・runtime scope・NHI scope の一体的な検証になっていない。

**判定:** P0/P1 相当。tenant-specific な runtime ask を、scope なしの system queue へ投入できることが最大の境界欠落である。キューを tenant 別ディレクトリへ即時分割するより、まず request / result / event に scope を要求し、scope の lineage と NHI を supervisor で検証するべきである。

### 3.3 スケジュールタスク

スケジュールは次の global registry に保存される。

```text
active/shared/runtime/media-generation/schedules/{schedule_id}.json
```

`generation-schedule.schema.json` と `GenerationSchedule` は trigger、job template、execution policy、delivery policy を持つが、tenant / organization / project / mission を必須の scope として定義していない。scheduler daemon の leader lease、heartbeat、trigger idempotency も system-wide である。

この構造では、scheduler daemon 自体は system service として動かせる一方、以下を保証できない。

- tenant A の schedule が tenant B の artifact path を指定しないこと。
- dependency や idempotency key が tenant を跨いで衝突しないこと。
- confidential artifact を tenant なしで配信しないこと。
- `list`、`tick`、replay の結果が caller の tenant scope へ限定されること。

`tenant-rate-limit-policy.json` は推論 token の rate limit を扱う既存の制御面であり、メディア生成の quota とは分離する。今回、メディア生成については `media-generation-quota-policy.json` と tenant 単位の abstract unit counter を追加し、provider submission 前の reservation と job ID 未取得時の release を実装した。

**判定:** P1。schedule record の scope と delivery ownership を先に型付ける必要がある。scheduler process を tenant ごとに増やすことは第一段階の解決策ではない。

### 3.4 surface runtime

surface manifest と `surface_runtime.ts` は、surface の起動・停止・health・port・service identity を扱う。Chronos、Presence、Slack、Telegram 等の surface process は system/service-level の lifecycle として管理されている。これは妥当である。

ただし、manifest に次の区別がない。

- process が system-wide service なのか、特定 tenant 専用 service なのか。
- viewer-derived、server-bound tenant、request-derived、system のどの方式で data scope を得るのか。
- surface が許可される tier と、配信先 tenant の境界。

`MSN-SYSTEM-SENSORY-HUB` や `KYBERION_PERSONA=sovereign` のような static runtime identity は process owner を示す情報であり、処理中の tenant を意味するものとして流用してはいけない。

**判定:** P1/P2。surface lifecycle を tenant に無理に分割するのではなく、manifest に process scope mode と request scope policy を追加し、data-bearing operation では別途 scope envelope を必須にするべきである。

### 3.5 channel / surface coordination

外部 channel と Kyberion 内の surface coordination は概念上分離されている。`channel-port-surface-model.md` では channel は外部相互作用、port は具体的な ingress / egress binding、surface は実行面として説明されている。

一方、実装の coordination store は次の global path を利用する。

```text
active/shared/coordination/channels/{surface}/requests/
active/shared/coordination/channels/{surface}/notifications/
active/shared/coordination/channels/{surface}/outbox/
active/shared/coordination/channels/{surface}/dead-letter/
active/shared/coordination/channels/{surface}/dead-targets/
```

`SurfaceAsyncRequestRecord`、`SurfaceNotificationRecord`、`SurfaceOutboxMessage`、dead-letter / dead-target record に tenant / organization / project の canonical scope がない。dead-target の key も channel ベースであり、同じ channel identifier が tenant 間で再利用された場合に delivery state が混ざる可能性がある。

`customer-channel-binding.ts` には外部 surface + channel ID から `tenantSlug` を解決する仕組みがある。しかし、調査した generic coordination 経路では、この解決結果を request / notification / outbox の scope として固定する利用が一般化されていない。

**判定:** P1。channel binding は単なる表示用 metadata ではなく、ingress authorization の入力として扱い、最初の inbound normalization で tenant scope に変換する必要がある。

### 3.6 viewer / projection / event・ledger

Chronos の `ViewerContext` は、server-side token の tenant set と role / tier を基に viewer scope を解決し、client の指定は許可集合の narrowing に限定している。Presence も remote path では server-side tenant binding を持つ。この二つは target model の参照実装になる。

ただし loopback localadmin の `tenantSlugs: 'all'` や system operator の aggregate view は tenant view ではない。これらは明示的な `scope_kind: system` または brokered read として分類し、tenant viewer と同じ projection path に暗黙に流さない必要がある。

イベント・ledger 側には既に canonical `scope` の設計と `eventScopeMatches` がある。今後はこの仕組みを runtime / schedule / surface / channel の durable record に広げ、各 layer が独自の tenant field や channel-only filter を増やさないことが重要である。今回の継続実装では、`metrics` の resource usage と cost report にも同じ scope を正本として追加した。

### 3.7 今回の実装状況

本報告に基づく第一段階として、agent runtime の scope envelope を実装した。

- `libs/core/runtime-scope.ts` を追加し、`EventScope` の normalize、mission state を authority とした解決、lineage mismatch、NHI の tenant / organization mismatch を fail closed にした。
- supervisor の prewarm request / result、ensure / ask payload、runtime registry / snapshot、supervisor event、token usage metrics に nested `scope` を伝播するようにした。
- system-only runtime は `scope_kind: system` を付与し、mission 付き runtime は mission state または明示された task scope を解決できない場合に投入を拒否する。
- mission team orchestrator と `AgentExecutionPort` から runtime scope を渡すようにした。
- runtime scope の契約、scope 欠落、authority tenant mismatch、NHI tenant mismatch を含む focused tests を追加した。
- `ResourceUsageRecord` に canonical scope を追加し、runtime の input / output token usage を top-level scope として保存するようにした。
- cost report に tenant / organization / project の集計軸と scope filter を追加した。tenant / entity filter 時は scope のない legacy record を fail closed で除外する。

### 3.8 実装済みの scope propagation

本レポートの実装可能な第一段階として、runtime に続いて channel / surface / schedule の request scope を追加した。

- channel coordination の async request、notification、outbox、dead-letter、dead-target に canonical な scope を保存し、scope filter 付きの list / update / clear / replay を提供するようにした。
- `resolveSurfaceIngressScope` は request-derived surface で customer channel binding を解決し、外部 inbound の最初の coordination record に tenant scope を固定する。binding のない入力は tenant と推測しない。
- outbox の deduplication と dead-target は scope 単位で分離し、既知の message ID / dead-letter ID を別 tenant の scope で操作しても、未発見として fail closed になる。
- surface provider manifest に `process_scope`、`scope_mode`、`allowed_tiers`、channel binding 要否を追加した。Slack / Discord / Telegram / iMessage は request-derived、Chronos / Presence は viewer-derived、process は現段階では system と明示している。
- generation schedule は既存の global registry を維持しつつ、read / write / run-lock に system/public の既定 scope を付与し、tenant scope を持つ schedule の list と claim を filter できるようにした。既存 schedule は互換のため system/public として正規化される。
- tenant schedule には tenant artifact namespace の既定 path を与え、明示された artifact / alias / target path が別 tenant または shared export へ出ないよう registration/read 時に検証する。dependency lookup も同じ scope に限定し、正規の register / daemon tick は tenant registry の active profile を必須とする。provider submission 前には media generation 専用の abstract unit quota を予約し、推論用 token bucket と混在させない。
- Chronos の collaboration、cost、operator-home は strict viewer scope と reader-side migration を通す。tenant view では unscoped legacy usage を集計しない。

したがって、tenant レコードの新規書き込みについては物理 namespace 分割まで実装済みである。system レコードは従来の system root に残し、tenant レコードは `tenants/{tenant}/...` 配下へ保存する。既存 flat record の apply と旧 source 消失確認も完了した。schedule の tenant delivery path / dependency scope check / registry validation / submission quota の最小境界、主要 Chronos projection、offboarding の physical namespace discovery / export / soft-delete / leftover verification まで実装した。tenant backup/export も channel、presence、generation schedule / artifact / cost settlement に加えて peer messaging、conversation、Mesh Hub の runtime / observability を対象 tenant だけ収集し、tenant restore 後は peer runtime を quarantine する。残る viewer / その他 export 経路を接続する段階である。

### 3.10 physical namespace migration（実装・apply・offboarding 接続済み）

新規 tenant レコードの保存先は、論理 record kind より上位に tenant namespace を置く。

```text
system: active/shared/coordination/channels/slack/outbox/{id}.json
tenant: active/shared/coordination/channels/slack/tenants/{tenant}/outbox/{id}.json
system: active/shared/runtime/presence/notifications/{id}.json
tenant: active/shared/runtime/presence/tenants/{tenant}/notifications/{id}.json
system: active/shared/runtime/media-generation/schedules/{id}.json
tenant: active/shared/runtime/media-generation/schedules/tenants/{tenant}/{id}.json
```

`libs/core/physical-namespace.ts` が tenant/entity lineage の path segment を検証し、surface coordination と generation scheduler が同じ resolver を使う。tenant-scoped read は対象 tenant subtree だけを走査する。system/operator の aggregate read は `includeTenantNamespaces` を明示した場合だけ tenant subtree を観測でき、tenant viewer の認可には使わない。外部 egress bridge は aggregate read を channel binding と scope の一致検証を通した brokered delivery として扱う。

既存 flat record は `pnpm migrate:physical-namespaces -- --dry-run --kind all` で計画を出し、`--apply` で移動する。canonical / mission-derived scope がある record だけを tenant namespace へ移動し、unscoped / invalid record は tenant を推測せず `active/shared/runtime/migrations/physical-namespace/quarantine/` へ移す。destination collision は上書きせず停止する。今回の apply では surface の 10件を移動し、135件を quarantine した。apply 後の tenant reader は flat path を互換 source として扱わないため、quarantine manifest が cutover の監査証跡になる。

`scope-offboarding.ts` の tenant / project discovery も physical namespace を対象に含めた。tenant offboarding は schedule、channel coordination、presence coordination の tenant subtree を export → soft-delete → leftover verification の同じ ceremony で処理する。project offboarding は `tenant_slug` / `organization_id` lineage を使い、project ID が複数 namespace に存在する場合は ambiguity として停止する。

### 3.9 reader-side migration（第一段階完了）

ledger は hash chain を持つため、既存 JSONL をその場で書き換える backfill はこの段階では行わない。`libs/core/scope-migration.ts` が durable record を次の規則で読み替える。

- nested canonical `scope` が有効なら `canonical` として採用する。
- scope がない legacy record は、mission state が現存し authority scope を復元できる場合だけ `mission-derived` として扱う。
- mission state がない、scope が malformed、record と payload の scope が衝突する場合は `unscoped-legacy` または `invalid` とし、tenant/entity reader から除外する。
- `ledger.loadForScope`、agent collaboration projection、cost report はこの同じ reader-side migration を利用する。flat な `tenant_slug` だけから tenant ownership を推測しない。

この方式により、system operator は legacy debt を観測できる一方、tenant viewer は不確かな record を見ることがない。物理 backfill は、hash chain の再構築、監査証跡、retention、rollback を含む別の移行ミッションで扱う。

## 4. 推奨する target model

### 4.1 `process_scope` と `request_scope` を分離する

すべての長寿命 process に tenant を直接埋め込むのではなく、次の二層を明確にする。

```text
process_scope
  system | tenant-service
  process owner / authority / health / shutdown

request_scope
  EventScope
  tier + tenant + organization + project + mission + task + session
  optional nhi_id / viewer_principal / work_shape
```

例として、system-level の一つの supervisor が tenant A と tenant B の request を処理することは許容する。ただし、各 request は次を満たす。

1. authority（mission / work item / channel binding / schedule owner）から scope を得る。
2. `resolveEventScopeAgainstAuthority` 相当で caller supplied scope の衝突を拒否する。
3. runtime、result、event、metric、delivery record へ同じ scope を伝播する。
4. tenant-specific operation は scope 欠落時に fail closed する。

### 4.2 共通 envelope

新規の runtime / schedule / surface / channel record に、少なくとも次の nested scope を持たせる。

```json
{
  "scope": {
    "scope_kind": "task",
    "tier": "confidential",
    "tenant_slug": "kyberion-service-studio",
    "organization_id": "kyberion-development-team",
    "project_id": "PRJ-KYBERION-DEV-TEAM-OPS",
    "mission_id": "MSN-...",
    "task_id": "TASK-...",
    "nhi_id": "nhi://..."
  }
}
```

`viewer_principal` は record の所有 scope ではなく、閲覧・操作を行った principal の監査情報として扱う。`customer_stance` も同様に scope chain の代替にはしない。

### 4.3 agent runtime

- ensure / ask / status / result / supervisor event に `scope` を追加する。
- tenant/entity request では `scope.tenant_slug` と mission / work item の authoritative scope を照合する。
- NHI の affiliation tenant と request tenant の mismatch を拒否する。
- `AgentRecord` の runtime metadata だけに tenant を隠さず、snapshot と event の canonical scope に出す。
- system maintenance agent は `scope_kind: system` を明示し、tenant data を扱う場合は brokered child request を作る。
- provider/model の選択は runtime scope と同じ preflight で検証する。obsolete provider を暗黙の default にしない。

### 4.4 schedule

schedule record の scope を次のいずれかで明示する。

- `system`: housekeeping、public-only、cross-tenant broker の管理処理。
- `tenant`: tenant 全体の定期処理。
- `organization` / `project`: その containment 内の定期処理。
- `mission` / `task`: 作業期間に限定された処理。

confidential artifact を生成・配信する schedule は tenant scope を必須とする。delivery path、dependency、run lock、idempotency key、rate limit key はすべて tenant/entity scope を含める。移行中は global registry を維持してもよいが、read / tick / write の認可は scope filter を通す。

### 4.5 surface

manifest に、lifecycle と data boundary を分ける次の宣言を追加する。

```json
{
  "process_scope": "system",
  "scope_mode": "viewer-derived",
  "allowed_tiers": ["public", "confidential"],
  "requires_channel_binding_for_customer_mode": true
}
```

推奨する `scope_mode` は次の四種類である。

| mode                  | 利用例                                  | tenant の取得元                                |
| --------------------- | --------------------------------------- | ---------------------------------------------- |
| `system`              | scheduler、health、operator maintenance | system authority。tenant data は直接扱わない   |
| `server-bound-tenant` | tenant 専用 bridge                      | server configuration と registry               |
| `viewer-derived`      | Chronos / Presence                      | server-side viewer token                       |
| `request-derived`     | Slack / external channel                | channel binding または authoritative work item |

### 4.6 channel

外部 inbound は次の順序で正規化する。

```text
external event
  → surface / port authentication
  → channel binding resolution
  → ChannelContext + EventScope
  → mission / task / surface coordination record
  → runtime ask / outbound delivery
```

customer mode で binding がない channel は tenant request として扱わず、system/operator inbox または拒否にする。`SurfaceAsyncRequestRecord`、notification、outbox、dead-letter、dead-target には scope を保存し、deduplication key と dead-target key にも tenant / entity を含める。

### 4.7 event / ledger / projection

- 新規 record は nested canonical `scope` を正本にする。
- legacy flat field は migration 判定の補助情報に限り、tenant viewer の authorization source や物理 namespace の代替にしない。
- system aggregate は system scope と brokered authority を明示する。
- projection は書き込み正本ではなく、`eventScopeMatches` 等で filter 後に生成する。
- token usage、cost、runtime health、delivery result も同じ scope を持たせる。token usage と cost report は今回 scope 化したため、tenant 別のコスト・品質・失敗率の改善ループを正しく分けるための最小観測線ができた。
- `CostLedgerEntry.scope` は authorization の代替ではない。HTTP / operator API は server-side の viewer scope を解決したうえで、許可された filter だけを渡す。
- legacy record は reader-side migration で authority-backed scope を補える場合だけ projection に入れ、補えない record は tenant view から除外する。
- media generation quota は `generation-quota.ts` の日次 abstract units として記録し、reasoning token rate limit や provider の実ドルコストとは別の制御面にする。quota の reservation は provider submission 前、失敗時の release は job ID 未取得時だけ行う。

## 5. 段階的な実装順序

### Phase 0: 契約と観測

- `RuntimeScopeEnvelope` / `ChannelContext` を `ScopeContext` / `EventScope` の thin wrapper として定義する。
- 各 record の scope propagation matrix を作り、source authority と fail-closed 条件を決める。
- unscoped legacy record を system-only とする reader policy を追加する。
- scope mismatch / missing scope / NHI mismatch の監査イベントを定義する。

### Phase 1: agent runtime

- supervisor ensure / ask / result / status に scope を追加する。
- mission / WorkItem authority と NHI affiliation を preflight で照合する。
- runtime snapshot、supervisor event、token metrics に canonical scope を出す。
- system supervisor は維持し、まず per-request isolation をテストする。

### Phase 2: channel と surface（第一段階完了）

- channel binding の解決結果を inbound の最初の scope authority にする。
- async request / notification / outbox / dead-letter / dead-target に scope を追加する。
- tenant を含む dedup / dead-target key を導入する。
- manifest に `process_scope` と `scope_mode` を追加する。（実装済み）
- strict filter を導入済みのため、tenant レコードの物理 namespace 分割を適用する。system root は維持し、tenant subtree だけを移行する。

### Phase 3: schedule（scope envelope 第一段階完了）

- schema と runtime record に scope envelope を追加する。既存 record は system/public に正規化する。（実装済み）
- tenant/entity ごとの delivery path validation、dependency lookup、run lock、idempotency、rate limit を実装する。（delivery path、dependency scope check、media quota、provider 報告額のみを対象にした冪等な実コスト精算、Chronos の scope-aware 表示まで実装済み。プロバイダが額を返さない場合は未確定として表示する）
- system schedule と tenant schedule の登録・list・tick 権限を分ける。

### Phase 4: viewer と projection（主要 Chronos 経路の第一段階完了）

- Chronos、Presence、operator surface で system view / tenant view / brokered view を UI と API の両方で明示する。
- client supplied tenant は引き続き narrowing のみにする。
- `all` は tenant set ではなく system/brokered authority として表示・監査する。
- Chronos collaboration / cost / operator-home は strict viewer scope と scope-aware projection を利用する。（実装済み）

### Phase 5: 移行と offboarding

- `migrate:physical-namespaces --dry-run` で対象を分類し、canonical / mission-derived だけを移動する。unscoped / invalid は quarantine へ隔離し、owner が確認する。
- `--apply` 後は tenant reader が flat path を参照しないこと、manifest と hash が保存されていることを確認する。（今回の apply で旧 source 0件、hash mismatch 0件を確認済み）
- tenant offboarding は queue 停止、schedule 停止、surface binding 停止、projection 停止、export / retention の順に実施する。
- tenant ごとの runtime process isolation は、要件または監査上必要な場合だけ追加する。

## 6. 必須 acceptance test

1. tenant-specific request が scope なしで supervisor queue に入らない。
2. tenant A の NHI で tenant B の mission / task を ensure / ask できない。
3. tenant A の channel binding から tenant B の coordination record を read / replay できない。
4. tenant A の schedule が tenant B の delivery path、dependency、lock、rate bucket を利用できない。
5. system-level process が複数 tenant を処理しても、各 result / event / metric に元の request scope が残る。
6. unscoped legacy record は tenant viewer に表示されず、system operator の migration view のみで扱える。
7. `tenant_slug` が registry 未登録、inactive、または reserved scope name の場合に fail closed する。
8. cross-tenant operation は brokered authority、許可 tenant 集合、監査イベントを持たない限り拒否される。
9. system / tenant / brokered viewer の UI 表示と API filter が同じ scope semantics を使う。
10. token usage、cost、delivery failure の集計が tenant / organization / project を跨いで混ざらない。

## 7. 今後決めるべき設計判断

| 判断                                        | 推奨                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| supervisor を tenant ごとに分けるか         | 初期は system supervisor + request scope。規制・高隔離 tenant のみ process isolation                          |
| storage path を即 tenant namespace 化するか | typed scope + fail-closed filter を先に導入し、現在は tenant write と migration apply を物理 namespace に接続 |
| binding のない外部 channel を許可するか     | customer mode では不可。system/operator mode だけ許可                                                         |
| schedule に tenant を必須にするか           | confidential artifact を扱う schedule は必須。system は public / housekeeping に限定                          |
| `all` を tenant scope として扱うか          | 扱わない。system または明示的 brokered read とする                                                            |
| stance をどこへ保存するか                   | audit / presentation metadata に限定し、authorization の tenant field には使わない                            |

## 8. 影響範囲と次の実装ミッション

今回の調査で、tenant の導入自体をやり直す必要はない。必要なのは、既存の canonical scope を周辺の durable contract へ伝播させることである。agent runtime、channel coordination、surface provider policy、schedule record の第一段階を実装したため、残りは次の順で独立した WorkItem に分割するのが安全である。

1. `schedule-tenant-scope` — delivery path、dependency、idempotency、quota、system / tenant authority 分離。（provider actual cost の settlement と Chronos 表示まで実装済み。provider invoice の再取得は各 provider adapter の次課題）
2. `scoped-projection-and-migration` — event / ledger / UI / legacy records。reader-side migration と主要 Chronos projection、tenant backup の主要 physical namespace filter は実装済みのため、残る viewer / その他 export 経路への接続と legacy debt の一覧化を行う。
3. 物理 namespace 移行 — queue / dead-letter / schedule の tenant 分離と backfill。resolver、dry-run/apply、offboarding 接続まで実装済み。

各 WorkItem は、単に `tenant_slug` を追加するのではなく、**scope の authority、lineage 検証、欠落時の動作、監査、projection filter** までを完了条件に含める必要がある。

本書は調査・設計レポートであり、今回の実装では runtime、channel coordination、surface provider policy、schedule record、tenant registry validation、tenant delivery path / dependency scope check、media quota、provider 報告額の実コスト精算、resource usage / cost report、reader-side scope migration、主要 Chronos projection、tenant physical namespace resolver、migration dry-run/apply、tenant backup の physical namespace 対応、physical namespace を含む offboarding の第一段階までを反映した。残る provider invoice 再取得と全 viewer / その他 export 経路への接続は次の実装ミッションとする。

## 9. Surface と surface 外サービスの境界

今回追加で、外部入口だけでなく、peer-messaging、MCP、review check、report-review の
責務も確認した。結論は、すべてを `surface` と呼ばず、次の三分類に分けることである。

| 分類                   | 役割                                                               | tenant の扱い                                                       | 人間向け表示                                                  |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `surface`              | 人間または外部チャネルとの対話・表示・承認入口                     | viewer / channel binding / server binding から request scope を解決 | Presence、Chronos、Concierge、Slack 等                        |
| `protocol gateway`     | MCP、peer、webhook 等の通信プロトコルを受け渡す                    | caller principal、binding、NHI、canonical scope を毎 request で検証 | 必要なら Chronos / Operator から health と delivery を表示    |
| `control-plane worker` | review、scheduler、reconcile、backup、activation 等の durable 制御 | authority の scope を継承し、scope なしの tenant 処理を拒否         | 結果・gate・evidence を Chronos / Concierge / Operator が表示 |

### 9.1 各 surface の target contract

- Slack、Telegram、Discord、iMessage は `process_scope=system`、
  `scope_mode=request-derived` の channel adapter とする。最初の inbound で認証済み
  channel binding を解決し、`ChannelContext + EventScope` を coordination record、NHI、
  outbound delivery へ固定する。binding がない customer mode は tenant と推測せず、拒否または
  system/operator inbox に送る。
- Presence Studio と Concierge は対話・承認の surface であり、tenant selector は
  authorization ではない。server-side `ViewerContext` の許可集合を狭めるだけにする。
- Chronos は control-surface であり、tenant、organization、project、mission を明示して
  表示する。介入は mission controller、approval-store、runtime supervisor 等の authority
  へ委譲し、route が状態を直接変更しない。
- Operator Surface は read-only の監査表示、Computer Surface は実行中の手元ミラーである。
  いずれも tenant を選択しただけで権限が広がらない。Computer Surface の表示対象も元の
  request scope を引き継ぐ。
- voice、terminal、MCP client などの入口は、会話を受けるかどうかではなく、どの port から
  どの authority へ handoff したかで分類する。surface agent は対話品質と handoff を担当し、
  durable mission owner にはならない。

surface provider manifest の `process_scope` / `scope_mode` / `allowed_tiers` と、protocol
service registry の `principal_resolution`、`write_authority`、`nhi_binding`、
`approval_classes`、`data_residency` を起動時の登録契約に含めた。scope policy または protocol
authority のない provider / gateway は登録・起動できない。

### 9.2 peer-messaging は surface ではなく protocol gateway

peer-messaging と Mesh Hub は Kyberion 間の transport / nerve であり、人間向け surface ではない。
既に peer envelope は tenant ID と HMAC を要求し、runtime / observability も
`tenants/{tenant}` 配下に分かれている。この方向は正しいが、次の envelope を共通契約にする。

```json
{
  "principal": { "kind": "nhi", "id": "nhi://..." },
  "scope": {
    "scope_kind": "organization",
    "tier": "confidential",
    "tenant_slug": "tenant-a",
    "organization_id": "org-a"
  },
  "peer_id": "peer-b",
  "approval_ref": "apr-...",
  "correlation_id": "..."
}
```

同一 tenant は default allow としてよいが、tenant 間は brokered operation とし、許可 tenant
集合、目的、NHI、承認、監査イベントを必須にする。peer listener の `--tenant-id` は process
binding であって、受信 envelope の scope 検証を省略する理由にはならない。backup / restore
では peer と Mesh の runtime を通常のデータと同時に active 化せず、restore quarantine →
再認証 → 再接続の順にする。

### 9.3 MCP は surface registry ではなく protocol gateway registry

現在の `mcp-server-cowork` は lifecycle 管理上 `surface` として登録され、MCP tool catalog は
tool、tier、caller role、approval の allowlist を持つ。運用上は起動・health を surface
runtime で管理してよいが、意味論としては `gateway` として別 registry に分けるべきである。

MCP request ごとに次を server-side で確定する。

1. MCP session / client の認証済み principal と caller role
2. tool が要求する tier、tenant、organization / project scope
3. tool 実行に使う NHI と、その affiliation の一致
4. read / write / external egress の approval class
5. pipeline、job、audit、artifact の canonical scope

tool 引数の `tenant` は認可情報ではなく narrowing hint とする。特に `audit.verify`、
`audit.export`、`pipeline.run`、`service.actuate` は、client が tenant を指定しただけで
実行できないようにする。MCP の default public-only は安全な既定値だが、confidential を
許可する場合は `ViewerContext` または明示的な MCP grant と `RequestContext` を結合する必要がある。

### 9.4 review check と report-review

mission review gate、background review、visual review、report-review は同じものではない。

- review gate / background review は `control-plane worker`。mission / task の authority を
  継承して findings、decision、evidence を保存し、実行権限や承認権限を持たない。
- Chronos、Concierge、Operator は review 結果を表示・承認する renderer であり、HTML や
  ブラウザ local state を gate の正本にしない。判定の正本は approval-store と mission gate
  record とする。
- `scripts/report-review/server.ts` は localhost の一時的な artifact review port である。
  起動時に `artifact_ref + EventScope + viewer_principal` を受け、confidential / personal
  artifact は tenant scope を必須にする。save はその artifact のみに固定し、review session、
  scope、viewer principal、comment count を tenant-scoped receipt に記録する。local token は
  viewer session の補助であり、人間の承認正本にはならない。

したがって review check や report-review を `active-surfaces` に追加して対話 surface と
同列に扱うのではなく、`review service` の lifecycle / port / evidence を別に登録し、必要な
renderer からリンクする設計が適切である。

## 10. Onboarding と設定変更の共通機構

オンボーディングと日常の設定変更は、別々の JSON writer を増やさず、同じ
**Scope Change / Configuration Mission** として扱う。既存の `tenant:activation` と
`config-mission` はこの基礎になるため、置き換えではなく共通 envelope と gate を追加する。

### 10.1 共通 lifecycle

```text
intent
  → draft (target scope / diff / risk / owner)
  → preflight (registry / viewer / NHI / service / isolation)
  → approval (scope と payload hash に束縛)
  → apply (governed writer / pipeline)
  → reconcile (実状態・health・projection確認)
  → receipt + audit + rollback point
```

`apply` は draft の存在だけでは実行できない。少なくとも target scope、before fingerprint、
desired fingerprint、authority role、NHI、approval ref、preflight probe ref を検証し、
失敗時は `failed` と recovery action を記録する。外部 credential、surface exposure、
egress、cross-tenant binding、global policy は高リスク変更として human approval を必須にする。

### 10.2 変更 scope と決裁者

| target scope              | 例                                                  | default authority                        |
| ------------------------- | --------------------------------------------------- | ---------------------------------------- |
| system                    | provider catalog、global runtime、protocol registry | owner / system operator + human approval |
| tenant                    | service binding、quota、egress、memory policy       | tenant owner / accountable human         |
| organization              | team、NHI assignment、operating model               | organization owner                       |
| project / mission         | worker roster、budget、review gate                  | project / mission owner                  |
| surface / channel binding | Slack workspace、MCP grant、review port             | service owner + tenant owner             |
| personal                  | user preference、voice、local review UI             | 本人。ただし external effect は別 gate   |

`customer/{slug}` は stance の変更であり、tenant scope の変更とは別の change kind にする。
tenant、organization、surface binding を一度に変更する onboarding でも、contained scope
ごとの diff と probe を持つ一つの parent change に分解して、部分成功を曖昧にしない。

### 10.3 実装候補

1. `ConfigMissionBrief` に `scope`、`target_kind`、`requested_by`、`nhi_id`、
   `before_hash`、`desired_hash`、`approval_ref`、`probe_refs`、`rollback_ref` を追加する。
2. `config-mission apply` を `preflight → approval-store → governed pipeline → reconcile`
   の順へ変更する。surface や MCP からも同じ command / library を呼び、直接 JSON を書かない。
3. onboarding は identity、tenant registry、organization binding、NHI provision、
   viewer scope、service/channel binding、first-work の各段階を child change として記録する。
4. `knowledge/product/governance/protocol-service-registry.json` に各 entry の `process_scope`、
   `request_scope_mode`、`health`、`owner`、`binding`、`approval`、`principal_resolution`、
   `write_authority`、`nhi_binding`、`approval_classes`、`data_residency`、`data_paths` を持たせる。
5. `surfaces:reconcile`、peer listener、MCP server、review server、scheduler は registry の
   lifecycle adapter とし、registry が許可しない状態では起動せず、停止・再接続・restore は
   receipt を残す。protocol service registry に `lifecycle_actions` を追加し、共通の
   `protocol-service-lifecycle` が system / tenant の物理 namespace へ receipt を保存する。

`ConfigMissionBrief` と MCP / report-review の request context は共通化済みであり、MCP の
高リスク tool は `approval_ref`、payload hash、effect binding、scope を同じ approval store
へ束縛する。peer listener、MCP server、report-review server、scheduler、backup-restore は
共通 lifecycle receipt を記録する。receipt 自体も tenant scope を持ち、tenant がある場合は
`active/shared/observability/protocol-services/{service}/tenants/{tenant}/` に保存するため、
system の health と tenant の restore / reconnect を混在させない。残る作業は
`surfaces:reconcile` の protocol-compatible surface 起動結果を同じ receipt stream に投影し、
再接続・restore の operator UI 表示へ接続することである。

## 参照した正本・実装

- `knowledge/product/architecture/entity-scope-hierarchy.md`
- `knowledge/product/architecture/multi-tenant-operations.md`
- `knowledge/product/architecture/agent-runtime-work-coordination-map.md`
- `knowledge/product/architecture/agent-runtime-observability-model.md`
- `knowledge/product/architecture/runtime-surface-lifecycle-model.md`
- `knowledge/product/architecture/channel-port-surface-model.md`
- `libs/core/entity-scope.ts`
- `libs/core/scope-context.ts`
- `libs/core/event-scope.ts`
- `libs/core/tenant-registry.ts`
- `libs/core/agent-runtime-supervisor.ts`
- `libs/core/agent-runtime-supervisor-client.ts`
- `libs/core/runtime-scope.ts`
- `libs/core/scope-migration.ts`
- `libs/core/generation-scheduler.ts`
- `libs/core/generation-quota.ts`
- `knowledge/product/governance/media-generation-quota-policy.json`
- `libs/core/agent-registry.ts`
- `libs/core/agent-identity.ts`
- `libs/core/generation-scheduler.ts`
- `knowledge/product/schemas/generation-schedule.schema.json`
- `libs/core/src/types/generation-schedule.ts`
- `libs/core/channel-surface-types.ts`
- `libs/core/surface-coordination-store.ts`
- `libs/core/surface-delivery.ts`
- `libs/core/surface-provider-policy.ts`
- `libs/core/surface-provider-manifest.ts`
- `knowledge/product/governance/surface-provider-manifests.json`
- `knowledge/product/governance/protocol-service-registry.json`
- `libs/core/channel-directory.ts`
- `libs/core/customer-channel-binding.ts`
- `knowledge/product/schemas/channel-port.schema.json`
- `knowledge/product/schemas/runtime-surface-manifest.schema.json`
- `presence/displays/chronos-mirror-v2/src/lib/viewer-context.ts`
