---
title: ナレッジ機構・学習ループ・UX 経路のスコープ整合計画(KS-01〜16)
tags:
  [
    tenant,
    scope,
    knowledge,
    context-ranker,
    context-pack,
    distill,
    memory,
    feedback,
    ux,
    governance,
  ]
last_updated: 2026-08-16
status: completed
---

# ナレッジ機構・学習ループ・UX 経路のスコープ整合計画(KS-01〜16)

## 目的

2026-08 のテナント/エンティティスコープ統合(EG / EV / TENANT_ORGANIZATION_ONBOARDING_AUTONOMY / PEER_TENANT_BACKUP_RESTORE)で、
config・protocol registry・approvals・MCP catalog・audit・events・runtime・onboarding は
「**authority から scope を解決 → lineage 検証 → 効果をゲート → scope 付き receipt/projection を永続 → reader は fail-closed**」
という同一パターンへ揃った。本計画は、同じパターンを **ナレッジ供給機構(context ranker・knowledge index・
mission context pack・distill・feedback/学習ループ)** と、**同コンセプト未適用で UX が劣化している経路**
(operator home・trace feed・surface query・reasoning policy・design cascade・skill/plugin 有効化)へ適用する。

正本 containment chain(`libs/core/entity-scope.ts`)を再掲する。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session   (+ work_shape / tier は直交軸)
```

## 現状確認(2026-08-16 read-only 監査・実装前スナップショット)

以下の表は実装前の問題を固定するための監査スナップショットであり、現在の実装状況は末尾の「実装状況」を正本とする。

`ScopeContext`(`libs/core/scope-context.ts:10`)を import するナレッジ系モジュールは **0 件**。
`resolveScopeContext` の利用者は `event-scope.ts` と `memory-scope.ts` のみ。ナレッジ機構は「tier のみ」または
「tenant のみを手書き」で止まっており、organization / project / mission / task 次元は存在しない。

| 機構                                                                     | 現在の scope 入力                                                | 隔離の実態                                                                                                                                                      | 出力/フィードバックの永続先                                                                                                               | 判定                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `scripts/context_ranker.ts`                                              | なし(`--scope` は `repository/global` の分類軸で chain ではない) | `knowledge/` **全体**を走査(`:192-256`)。tier はラベルのみで filter しない(`:221-227`)                                                                          | stdout                                                                                                                                    | ❌ 未整合(全テナント confidential + personal を横断表示) |
| `libs/core/ranking-signals.ts`                                           | `global/repository/mission/environment` の 4 値                  | chain の proximity ranking なし。未知値は 0.4 で黙って中位(`:24,32`)                                                                                            | —                                                                                                                                         | ⚠️ 語彙が chain と別物                                   |
| `libs/core/src/knowledge-index.ts`                                       | `tiers[] + customerId`                                           | `customerId` 省略時 `confidential/*` を**全列挙**(`:491-500`、fail-open が仕様)                                                                                 | embedding cache は scope 別                                                                                                               | ⚠️ 隔離は呼び手任せ                                      |
| `libs/core/tenant-knowledge-retrieval.ts`(DA-07)                         | `tenantSlug`                                                     | positive allowlist で tenant 隔離 ✅                                                                                                                            | —                                                                                                                                         | ⚠️ tenant 止まり(org/project/mission なし、lexical のみ) |
| `libs/core/memory-promotion-workflow.ts:68-70`                           | なし                                                             | `tiers:['public','confidential','personal','product']` を **customerId なし**で `buildScopedIndex` → 類似 hint を log と reasoning backend prompt へ(`:99-107`) | log                                                                                                                                       | ❌ クロステナント漏洩経路(egress gate 不通過)            |
| `libs/core/knowledge-provider.ts`                                        | なし                                                             | 相対 path をそのまま `knowledge/` から返す(`:35-77`)                                                                                                            | —                                                                                                                                         | ❌ tier/tenant アサートなし                              |
| `libs/core/knowledge-slices.ts`                                          | `team_role×phase×mission_type×tenant×project`                    | placement 指示のみ・isolation gate ではない。運用データの tenant は `"*"` のみ                                                                                  | —                                                                                                                                         | ⚠️ org/mission/task/work_shape なし                      |
| `libs/core/mission-context-pack.ts`                                      | tenant(mission state 由来 `:1209-1233`)+ project(slice)          | tenant corpus は隔離 ✅。**distill 経路は無フィルタ**(`:1357-1362`)。`pack.scope` は記述のみで執行しない                                                        | —                                                                                                                                         | ⚠️ 最良だが部分的                                        |
| `libs/core/task-knowledge-provisioning.ts`                               | pack 継承                                                        | egress gate は **tier のみ**(`:207-230`)                                                                                                                        | delivery telemetry に tenant/project なし(`:240-250`)                                                                                     | ⚠️                                                       |
| `libs/core/src/knowledge-feedback-loop.ts`                               | なし                                                             | —                                                                                                                                                               | `active/shared/runtime/feedback-loop/knowledge-{delivery,usage}/` **単一グローバル**(`:64-76`)。usage は `document_path` 単キー           | ❌ 全テナント混在                                        |
| `libs/core/distill-knowledge-injector.ts`                                | topic/tags のみ(`:97-109`)                                       | corpus は `knowledge/product/evolution` 固定(`:38-40`)                                                                                                          | —                                                                                                                                         | ❌ テナント由来蒸留が全体公開 or 到達不能                |
| `libs/core/cowork-knowledge-bridge.ts`                                   | tier のみ                                                        | tenant 次元なし → `confidential/{slug}/` へ着地できない                                                                                                         | —                                                                                                                                         | ⚠️                                                       |
| `libs/core/worker-context-compaction.ts`                                 | なし                                                             | egress gate なし                                                                                                                                                | `active/shared/tmp/context-compaction/{mission}/`(tenant 区画なし)                                                                        | ❌                                                       |
| `libs/core/context-promotion-ledger.ts`                                  | tenant/project/mission/purpose を記録・再検証 ✅                 | —                                                                                                                                                               | `active/shared/audit/context-promotion-ledger.jsonl` 単一                                                                                 | ⚠️ 台帳が未区画                                          |
| `contextual-intent-{memory,learning}.ts` / `intent-contract-learning.ts` | なし                                                             | —                                                                                                                                                               | `knowledge/personal/*.json`・`active/shared/runtime/intent-contract-memory.json` 単一(グローバル 500 件 cap で他テナントの学習を追い出す) | ❌ 学習した `default_approval_scope` がテナントを跨ぐ    |
| `HINTS.md`(`promoted-memory.ts:73-90`)                                   | なし                                                             | —                                                                                                                                                               | `knowledge/product/governance/HINTS.md` 単一 50 節                                                                                        | ❌                                                       |
| `libs/core/memory-scope.ts`                                              | full chain                                                       | tier→audience→owner→chain 全段比較(`:56-110`)                                                                                                                   | —                                                                                                                                         | ✅ **参照実装**                                          |
| `libs/core/context-security-scope.ts`                                    | full chain + purpose                                             | `compileScopedContextPack` に typed rejection(`TENANT/ORGANIZATION/PROJECT/MISSION_SCOPE_MISMATCH`)                                                             | —                                                                                                                                         | ✅ 契約は存在するが **pack builder が消費していない**    |

frontmatter 側: repo 全体で `scope:` 39 件(値は `repository`/`global` のみ)、`tenant`/`organization_id` を持つ
frontmatter は 0 件。ranking 語彙に chain を表す語彙が存在しない。

同コンセプト未適用の UX 経路(別エージェント監査、抜粋・実コード確認済み):

- `presence/displays/chronos-mirror-v2/src/app/api/traces/route.ts:30-51` — ViewerContext を解決するが `collectTraceFeed` へ tenant を渡さない(`trace-feed.ts` に tenant 参照 0)。兄弟 route(`approvals`/`deliverables`/`cost`/`agent-activity`)は渡している。
- `libs/core/operator-home-summary.ts:435-441` — `collectOperatorHomeSummary` に scope 引数がなく、route 側で **グローバル集計後に配列だけ JS で後段フィルタ**。`limit` がテナントフィルタ前に効き、非配列カウンタは全テナント値のまま。
- `chronos-mirror-v2/src/lib/viewer-context.ts:18-24` — `ViewerContext` は tenant まで。`workitems/route.ts:69,71` は `organization_id`/`project_id` を **クエリパラメータ**から受ける(viewer 未認可)。`KYBERION_VIEWER_SCOPE` の既定は `warn`。
- `libs/core/scope-context.ts:134-135` — `project_id`/`task_id` に env ソースがなく、CLI セッションは「今どの project か」を持てない。`resolveScopeContext` を使わず env を直読みするモジュールが十数件。
- `reasoning-backend-policy.json` / `reasoning-*-policy.ts` — tenant 参照 0(spend-guard の `tenant_overrides` 形が隣にあるのに未採用)。
- `libs/core/surface-query.ts` / `surface-query-overlay-catalog.ts:8` — overlay kind は `role|phase|personal` のみ、module singleton cache は path 単キー。providers JSON は `context_ranker` を宣言するが実経路は public-only hybrid index(宣言と実装の乖離)。
- `libs/core/creative-design-resolver.ts:135-141` — tenant 層のみ(org/project 層なし)。docx/xlsx engine は `resolveCreativeDesign` 未配線。`web-design-system.ts:245` は `tenant_slug:'kyberion'` ハードコード。
- `libs/core/skill-plugin-loader.ts:78-80` — `.kyberion-plugins.json` を cwd から読む flat list。`restricted-skills.json` は TS 消費者 0。
- `libs/core/tenant-rate-limiter.ts` — tenant 対応で実装済みだが消費者 0(実稼働は `policy-engine`= agentId、`api-guard`= IP)。
- `libs/core/locale.ts:117-165` — 解決順に tenant/org 段がない。`mission-templates.json` / `mission-team-templates.json` は tenant overlay なし。

## 設計判断

### 1. ナレッジ取得の choke point は「positive allowlist × ScopeContext」に一本化する

DA-07(`tenant-knowledge-retrieval.ts`)の「scope は必ず単一 subtree を名指す・blocklist を持たない」原則を、
`KnowledgeScope` から `ScopeContext` を受け取る新関数 `resolveKnowledgeScopeSet(scope: ScopeContext)` に一般化する。
`knowledge-index.ts` の `customerId` 省略時 confidential 全列挙は **fail-closed(空 scope)** に反転し、
全列挙が必要な system 用途は `{ authority: 'system' }` を明示させる(EventScope の `scope_kind: system` と同型)。
`knowledge-provider.ts` の raw path 読み出しは `assertKnowledgePathInScope(path, scope)` を通す。

### 2. ranking 語彙を chain へ寄せ、「scope proximity」を共通 signal にする

`ranking-signals.ts` の `global/repository/mission/environment` は互換のため残しつつ、
`scopeProximityScore(docScope, currentScope)`(same task > same mission > same project > same org > same tenant > common/public)
を `knowledgeMetadataScore()` に追加する。doc 側の scope は path(`knowledge/confidential/{tenant}/organizations/{org}/projects/{project}/…`
は `physicalScopeNamespace()` と同型)と frontmatter(`scope_context:` 任意)から導出する。frontmatter に tenant/org を
書かせるのではなく **配置場所が scope を決める**(EG の physical namespace と同じ原理)。

### 3. context pack は `compileScopedContextPack` を通してから組み立てる

既存契約 `context-security-scope.ts` を pack builder が消費し、tenant corpus・distill・slice pin・cowork 由来断片のすべてを
`GovernedContextFragment` として通す。`pack.scope` は記述から **執行済み scope + rejected[]** へ昇格し、KP-01 のバイト同一性は
「rejected が空のとき」に限定して維持する(テストで固定)。

### 4. distill / feedback / 学習は tenant を第一級 lane にする

- distill 出力: `knowledge/product/evolution/`(public lane、EG-10)に加え `knowledge/confidential/{tenant}/evolution/` を tenant lane とし、
  混入判定は候補の `scope`(mission state 由来)で決める。tenant lane は tenant 内 pack にだけ到達する。
- feedback(delivery/usage)・intent memory/learning・HINTS・compaction summary・promotion ledger は
  `scopeContextKey()` 由来の区画へ書く。読み出しは `memoryScopeAllowsRead` と同じ順序(tier→audience→chain)。
- 学習した既定値(`default_approval_scope` 等)は tenant を跨いで適用しない。

### 5. UX 経路は「authority で解決 → 源で絞る」に揃える(後段フィルタ禁止)

`ViewerContext` に `organization_ids`/`project_ids` を追加し、`workitems`/`operator-home`/`traces` は
クエリパラメータを **narrow only** で扱う。集計関数は `ScopeContext` を引数に取り、源で絞る。
CLI 側は `KYBERION_PROJECT_ID`/`KYBERION_TASK_ID` を `resolveScopeContext` に足し、
`currentScope()`(memoized)を全サブシステムの単一入口にする。

### 6. tenant で「上書きできる」ものは spend-guard の `tenant_overrides` 形に統一する

reasoning backend policy・surface query providers・design cascade(org/project 層)・skill/plugin 有効化・locale・mission templates
は、いずれも「global 既定 + `tenant_overrides[{slug}]`(+ 任意で org/project overlay)」の同一形で宣言し、
解決順を `project → organization → tenant → global` に固定する。cache key には `scopeContextKey` を含める。

## 実装フェーズ

### Wave 0 — 隔離の穴を塞ぐ(P0 / S-M)

- [x] **KS-01 context ranker のスコープ執行** — `scripts/context_ranker.ts` に `--tenant/--organization/--project/--mission` と env(`resolveScopeContext`)を追加し、`scanKnowledgeFiles()` を `resolveKnowledgeScopeSet` の allowlist 走査へ置換。scope 未指定は `public + product` のみ。受入: tenant 未指定で `knowledge/confidential/*`・`personal/` の path が一切出力されない。
- [x] **KS-02 knowledge-index の fail-closed 化** — `_scanConfidentialTier` は `customerId` 省略時に空を返し、system 全走査は `systemAuthority: true` 明示時のみ。`memory-promotion-workflow.ts:68` を候補の scope 由来 allowlist へ修正し、prompt 送出前に egress gate を通す。受入: 別 tenant の hint が promotion review の log/prompt に現れない。
- [x] **KS-03 trace feed の tenant フィルタ** — `traces/route.ts` が `withViewerExecutionContext` の tenant を `collectTraceFeed/collectTraceDetail` に渡す。受入: tenant A の viewer に tenant B の trace title/pipelineId が返らない。
- [x] **KS-04 knowledge-provider の path アサート** — `getJson/getText` に `scope` 省略時は `public/`・`product/` 限定、confidential は scope 一致必須。

### Wave 1 — 正準 scope をナレッジ供給に通す(P1 / M)

- [x] **KS-05 `resolveScopeContext` の完全化** — `KYBERION_PROJECT_ID`/`KYBERION_TASK_ID` を追加し、`currentScope()` を導入。env registry / example / configuration を更新した。env 直読みの全移行は別残タスク。
- [x] **KS-06 scope proximity ranking** — `ranking-signals.ts` に `scopeProximityScore` を追加し `knowledgeMetadataScore` へ合成。`context_ranker` と `knowledge-index` lexical/hybrid の双方に適用した。
- [x] **KS-07 mission context pack の scope 執行** — pack builder が `compileScopedContextPack` を消費し、distill/tenant hints を scope filter 後に採用する。`pack.scope_audit` は rejection がある場合だけ出力し、既存 golden の形を維持する。
- [x] **KS-08 tenant-knowledge-retrieval の chain 拡張** — `ScopeContext` を受け、organization/project/mission/entity prefix を優先する strict allowlist 走査へ拡張した。
- [x] **KS-09 provisioning egress の tenant 化** — `checkProviderEgress` へ `tenant_slug` を渡し、tenant profile の `allowed_reasoning_backends` と delivery scope を尊重する。

### Wave 2 — 学習・蒸留・フィードバックの区画化(P1 / M)

- [x] **KS-10 feedback store の区画化** — `knowledge-feedback-loop.ts` の delivery/usage を `…/tenants/{slug}/…` 配下へ(`physicalScopedPath`)。reader は scope 一致のみ集計し、旧グローバル記録は `unscoped-legacy` disposition として分離する。
- [x] **KS-11 intent memory / learning / HINTS / compaction の区画化** — intent memory/learning、intent contract、promotion ledger、HINTS、compaction summary の永続先を physical scope 区画へ分け、cap は区画ごとに適用する。compaction summary は egress gate 通過必須。
- [x] **KS-12 tenant distill lane** — `distill-knowledge-injector.ts`、promotion candidate、tenant evolution lane、cowork bridge の ingest tenant propagation を scope-aware にした。

### Wave 3 — 同コンセプトで UX を揃える(P2 / M)

- [x] **KS-13 ViewerContext の org/project 拡張と源側フィルタ** — `ViewerContext` に `organization_ids`/`project_ids`、Chronos の workitems/operator-home を source-side scope filter 化。クエリ値は narrow only。
- [x] **KS-14 tenant_overrides の横展開** — reasoning backend/route、surface query providers、locale、mission team templates、skill/plugin を `global → tenant → organization → project` の順で解決。
- [x] **KS-15 tenant-rate-limiter の実接続と locale/template overlay** — operation policy gate と Chronos API 入口で tenant budget を消費し、locale/team template overlay を tenant/entity lane から解決。
- [x] **KS-16 正直性 checker と文書** — `check:knowledge-scope` が scope なし `buildScopedIndex`、scope なし surface-query provider、グローバル confidential root 読みを検査する。

## 実装順序と依存

| 順  | 項目                          | 依存         | 規模                        |
| --- | ----------------------------- | ------------ | --------------------------- |
| 1   | KS-01〜04(Wave 0)             | なし         | S〜M・独立に並列可          |
| 2   | KS-05                         | なし         | M(以降の全 Wave の前提)     |
| 3   | KS-06 → KS-07 → KS-08 → KS-09 | KS-05        | M                           |
| 4   | KS-10〜12                     | KS-05, KS-07 | M(ファイル所有分離で並列可) |
| 5   | KS-13 → KS-14 → KS-15         | KS-05        | M                           |
| 6   | KS-16                         | 全て         | S                           |

## 受け入れ条件

1. tenant 未指定の `context_ranker` / `knowledge-provider` / `buildScopedIndex` から `knowledge/confidential/*`・`personal/` の内容が返却されない。
2. tenant A の scope で構築した context pack・promotion review・trace feed・operator home に tenant B 由来の path/title/カウントが含まれない。
3. `compileScopedContextPack` の rejected が空のとき、既存 KP-01 golden とバイト同一。
4. 同 project 配下の doc は同点の `confidential/common` doc より必ず上位に ranking される(決定的)。
5. feedback/intent/HINTS/compaction/distill の新規永続は tenant 区画に落ち、旧グローバル記録は `unscoped-legacy` として読み分けられる。
6. `KYBERION_PROJECT_ID` を与えた CLI セッションで `currentScope().project_id` が解決され、pack の project 優先 scope に反映される。
7. `restricted-skills.json` と `.kyberion-plugins.json` の tenant セクションに反する skill/plugin は loader が拒否する。
8. checker(KS-16)が CI で緑、かつ scope なしの `buildScopedIndex` 呼び出しを 1 件でも追加すると赤になる。

## 非目標

- tier モデル(personal/confidential/public)の再設計、既存 ledger JSONL のハッシュ鎖再構築(EG の migration mission 管轄)。
- embedding backend の統一・置換(lexical/hybrid 双方に signal を載せるだけ)。
- pipelines カタログの推薦機構新設(現状 recommender が存在しないため、tenant allowlist は別計画)。
- `KYBERION_VIEWER_SCOPE` 既定を `enforce` に上げること(運用判断、VISIBILITY_SCOPE_AUTHZ_PLAN 側)。

## リスク・注意

- KS-02 の fail-closed 反転は既存呼び手(`run_pipeline.ts:2906`、surface helpers)の挙動を変える。全 `buildScopedIndex` 呼び出しを先に棚卸しし(KS-16 checker を先行実装してよい)、system 全走査が必要な箇所は明示フラグへ移す。
- 区画化(KS-10〜12)は reader 側の後方互換が要る。EV/EG と同じく **書き込みは新区画・読み出しは disposition で読み分け**、一括移設は別ミッション。
- ranking 変更(KS-06)は KP golden・DA-07 テストの順位期待に影響し得る。proximity 重みは既定 0 で導入し、テストで順位を固定してから既定値を上げる。

## 関連

- [ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09](../../improvement-plans-2026-08/ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)(EG-10 distill 一本化、physical namespace)
- [TENANT_ORGANIZATION_ONBOARDING_AUTONOMY_PLAN_2026-08-15](./TENANT_ORGANIZATION_ONBOARDING_AUTONOMY_PLAN_2026-08-15.ja.md)(ScopeContext・memory-scope)
- [TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25](../2026-07/TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md)(KP-01〜07、tenant 次元を持たない前提)
- [KM-02_RETRIEVAL_QUALITY](../2026-07/KM-02_RETRIEVAL_QUALITY.ja.md)(Task 4 ranker 統一残)/ [KM-04_KNOWLEDGE_STORE_HYGIENE](../2026-07/KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md)(context_ranker 全走査の記載)
- [TENANT_DATA_ACTIVATION_PLAN_2026-07-28](../2026-07/TENANT_DATA_ACTIVATION_PLAN_2026-07-28.ja.md)(DA-07 tenant retrieval)
- [VISIBILITY_SCOPE_AUTHZ_PLAN_2026-08-05](../2026-07/VISIBILITY_SCOPE_AUTHZ_PLAN_2026-08-05.ja.md)(ViewerContext)

## 実装状況

- 2026-08-16: read-only 監査(3 経路: scope 契約/パターン抽出、ナレッジ機構 20 モジュール、UX 経路 10 候補)に基づき計画策定。
- 2026-08-16: Wave 0 を実装済み。`context_ranker`、`knowledge-index`、`knowledge-provider` は `resolveKnowledgeScopeSet` の positive allowlist を通り、未指定時は `public + product` に限定される。Chronos trace feed は viewer の tenant allowlist を source-side で適用する。
- 2026-08-16: Wave 1 を実装済み。`currentScope()` と project/task env、scope proximity ranking、context pack の `compileScopedContextPack`、chain-aware tenant retrieval、tenant-aware provider egress、delivery scope を追加した。task/session の fragment rejection も契約へ追加し、既存 pack のバイト互換は optional field が空のとき維持する。
- 2026-08-16: Wave 2 を実装済み。feedback delivery/usage、intent memory/learning、intent contract、promotion ledger、HINTS、compaction summary を tenant physical namespace に区画化し、tenant distill lane と scope-aware promotion/egress を追加した。旧グローバル記録は `unscoped-legacy` lane として従来 lane に残し、自動的に tenant 記録へ混ぜない。
- 2026-08-16: Wave 3 と KS-12 cowork bridge の残項目を実装した。Chronos viewer の organization/project scope、operator-home/workitems の source-side filtering、tenant/org/project overlay、rate limiter の API/policy 接続、Cowork tenant sync lane を追加した。KS-16 は direct-read/provider declaration 検査まで拡張し、focused tests・typecheck・checker を通過した。
- 2026-08-16: 実装後 read-only 監査で残を確認 — pack retrieval scope に org/project 未伝播(proximity 3/4 段が pack 経路で発火しない)、`scope_audit` の消費者 0、`check:knowledge-scope` の PR CI 未配線、受入 3/7/8 のテスト欠落、`unscoped-legacy` の移行/期限なし、新区画の backup/offboarding/retention 未登録、design cascade(設計判断 6)は未着手。これらは後続の [KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16](../../improvement-plans-2026-08/KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)(KO-01〜19)へ引き継ぐ。
