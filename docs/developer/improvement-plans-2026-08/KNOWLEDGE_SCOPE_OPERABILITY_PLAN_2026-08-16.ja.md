---
title: スコープ運用性計画 — UX・自律性・持続性(KO-01〜19)
tags:
  [
    tenant,
    scope,
    knowledge,
    ux,
    autonomy,
    sustainability,
    feedback-loop,
    curation,
    observability,
    governance,
  ]
last_updated: 2026-08-17
status: active
---

# スコープ運用性計画 — UX・自律性・持続性(KO-01〜19)

## 目的

[KNOWLEDGE_SCOPE_ALIGNMENT_PLAN(KS-01〜16)](../improvement-plans-archive/2026-08/KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16.ja.md)で、ナレッジ供給・学習ループ・
UX 経路は正準 chain(`tenant_slug → organization_id → project_id → mission_id → task_id → session`)で **隔離される**ようになった。
本計画はその次段として、スコープを「**見える・切り替えられる・説明できる**」(UX)、「**ループが人の再駆動なしに閉じる**」(自律性)、
「**数か月運用しても正しく・有界に保てる**」(持続性)状態にする。KS の実装直後 read-only 監査(実装検証 / UX / 自律性の 3 経路)で
確認した事実に基づく。

## 現状確認(2026-08-16、KS 実装後スナップショット)

### 実装検証(KS の残)

- `scope_audit`(pack から scope 理由で落とした断片)は `mission-context-pack.ts:300,1836` の型と writer 以外に参照が **0**。render・log・receipt・UI のどこにも出ない。
- pack の tenant retrieval scope は `{tier, tenant_slug, mission_id}` のみ(`mission-context-pack.ts:1425-1430`)。`organization_id`/`project_id` を渡さないため、KS-06 で導入した proximity ladder の org(3)/project(4) 段は **pack 経路から一度も発火しない**。
- proximity は重み設定を持たない固定 ladder(`ranking-signals.ts:95-113,171`)。他 signal は weight 駆動、ranker weight JSON に `proximity` キーなし → チューニング/ロールバックにコード変更が要る。
- `check:knowledge-scope` は `validate`(`package.json:178`)にのみ含まれ、`.github/workflows/ci.yml` / `pr-validation.yml` に無い(release 時のみ)。検査は構文的で `buildScopedIndex({tiers:['confidential']})` は通る。self-test なし。
- 受入条件 3(rejected 空時の golden バイト同一)・7(skill-plugin tenant 拒否)・8(checker 赤化)のテストが無い。
- `unscoped-legacy` lane は書くだけで reader なし(`knowledge-feedback-loop.ts:343`)、`migrate_physical_namespaces.ts:37` は `schedule|surface` のみ、期限・所有者なし。
- backup(`scripts/backup.ts:745-757`)と offboarding(`scope-offboarding.ts:489-491`)は新区画(feedback-loop / intent-contract / partitioned audit / context-compaction / cowork-sync / `knowledge/personal/tenants/{slug}`)を含まない。retention catalog も `feedback-loop` prefix のみ。cap は区画単位になったため総量は O(tenants×cap) で上限なし。
- `KYBERION_HINTS_PATH`(ファイル override)が tenant lane のディレクトリ基点として流用されている(`promoted-memory.ts:82-86`)。
- allowlist 走査ロジックが `knowledge-scope.ts:23-38` と `knowledge-index.ts:575-611` に二重実装。
- 未更新文書: `multi-tenant-operations.md`、`phases/alignment.md:19`(`context_ranker` を scope 引数なしで案内 → 現在は public+product のみを黙って返す)、`env-registry.json` の新 2 変数が `documented:false`。

### UX

- 「今どの tenant/org/project か」を出す手段が **CLI・Chronos・MCP のいずれにも無い**。289 の pnpm script に `scope`/`whoami` 相当なし。`onboarding:context show` は binding 表示で `currentScope()` を反映しない。`run_doctor.ts:170` は誤変数 `KYBERION_TENANT_ID` を読む。
- 切替 facade なし。`pnpm tenant` は create/update/…で `use` なし、`pnpm org` は role 管理、唯一の永続スイッチャ `customer:switch` は **stance**(chain 外)を書く。`current_mission_focus.json` は `{mission_id, ts}` のみで `shared/` 直下(区画なし)。
- ranker の scope 除外は `continue` のみ(`context_ranker.ts:229`)で件数も理由も出ない。scope を深くすると deepest root のみになり **doc が減るのに無言**。
- `mission create/start` は `tier:'confidential'` 既定で tenant 未指定を許容(`mission_controller.ts:421-428,505-511`)。`[SCOPE_CONTEXT_INVALID]` に是正案なし。tenant root が解決できても **0 件**のとき無警告(現に `knowledge/confidential/kyberion-service-studio/` は空)。
- 正準配置 `confidential/{tenant}/organizations/{org}/projects/{project}/…` はコード(`entityRoot()`)にしか無く、`pnpm knowledge place` 相当がない。実ツリーに `organizations/` 階層は未出現。
- Chronos: `ChronosTenantScope` は tenant のみ。API は `organization_id`/`project_id` を受けるが **UI からは一切送られない**(dead API surface)。scope breadcrumb なし。`KnowledgeWorkspace.tsx` に feedback UI なし。
- worker prompt: pack scope に `organization_id` が無い(`mission-context-pack.ts:157-165`)、working-principles に機密境界の原則が無い。
- ナレッジ feedback の "used" 信号は **worker の任意自己申告のみ**(`mission-orchestration-worker.ts:1426` "Optionally include…")。人間の useful/stale/wrong 経路なし。
- concierge setup route が `KYBERION_CUSTOMER`(stance)を tenant として表示(`concierge/src/app/api/setup/route.ts:54-57`)。

### 自律性

| ループ                              | 状態                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feedback → ranking                  | 記録のみ。`loadKnowledgeUsageAggregate` の唯一の消費者 `knowledge-curation-report.ts:277` が **無スコープ**で読む → KS-10 以降 tenant usage は write-only                                                                 |
| distill → promotion → common/public | 候補検出は自動(7 producer)、承認は手動(正しい)。cross-tenant の匿名化 pattern 昇格は **不在**(`promotion_policy: brokered` は生成されない)                                                                                |
| gap 検出                            | `missing_topics` 自己申告のみ。tenant retrieval が空/低スコアでも **記録されない**(warn-once はプロセス寿命)                                                                                                              |
| staleness                           | 週次 curation report は tier/kind SLO で検出するが是正は全手動。`review_by` なし。`check_tier_hygiene`・`heuristic-feedback` sweep は未スケジュール                                                                       |
| scope 推論                          | mission→worker は `readMissionScope` で自動。CLI/人の入口は env のみ(cwd/git/mission-state fallback なし)                                                                                                                 |
| legacy 移行                         | 読み時裁定(`mission-derived`)は自動、永続移行は手動・未報告。`unscoped-legacy` は新規にも書かれ **増え続ける**                                                                                                            |
| 学習ループ                          | 行動を変えるのは `intent-contract-learning` のみだが、呼び出し 3 箇所(`surface-runtime-orchestrator.ts:1203,1414`, `task-session.ts:257`)が scope を渡さず **global**。`contextual-intent-learning` は書くだけで reader 0 |
| 自己監視                            | ops-alert / health-degradation / `watch_tenant_drift` は成熟。ナレッジ・スコープ健全性の watcher は **無い**                                                                                                              |

## 設計判断

### 1. スコープは「解決 → 表示 → 記録」を一体にする(黙って適用しない)

`currentScope()` の結果と **各フィールドの出所**(env / scope.env / mission-state / cwd / binding / default)を
`ScopeResolution { scope, provenance }` として返す API を足し、CLI(`pnpm scope`)・MCP(`kyberion.scope.current`)・pack render・
Chronos header が同じ構造を表示する。scope 由来の除外(ranker の skip、pack の `scope_audit`、retrieval の空結果)は
**必ず件数と理由コード付きで出力**し、dispatch observability に載せる。

### 2. 切替は facade で、永続先は区画付き

`pnpm scope use|show|clear` が `active/shared/runtime/scope.env` を書き、`resolveScopeContext` の優先順を
`明示 input → env → scope.env → mission-state(MISSION_ID) → cwd/git 推論 → default` に固定する。推論は **tier を広げない**、
明示は常に勝つ。`current_mission_focus.json` は chain 全体を持ち `scopeContextKey` 区画に置く。

### 3. 既に出荷済みのループを「tenant 単位で閉じる」ことを最優先にする

新機構より先に、(a) pack retrieval scope へ org/project、(b) intent-contract 3 呼び出しへ `currentScope()`、
(c) curation report の tenant 反復 — の 3 点(各 S)で、KS が作った per-tenant データが実際に読まれ・効く状態にする。

### 4. 自律動作は「検出は自動・提案は自動・破壊的適用だけ人」

gap 記録、usage-yield による rank 補正(有界 ±、新規 doc を罰しない)、archive 提案、legacy 裁定 report、common 昇格提案は
すべて自動で走らせ、**既存の steward 承認(KM-03 promotion queue / ingest commit ceremony / apply confirmation)**を唯一の人手ゲートにする。
新しい承認 UI は作らない。

### 5. 持続性は「CI で赤くなる・有界・バックアップ/offboarding に含まれる・観測できる」の 4 条件で定義する

KS-16 checker を PR CI に入れ意味論検査へ拡張し、新区画を retention catalog / backup / offboarding / audit-continuity に登録し、
`watch_knowledge_scope_health` で日次に観測する。legacy lane には TTL と増加アラートを付け「死んだ」と宣言できるようにする。

## 実装フェーズ

### Wave 0 — 出荷済みループを tenant 単位で閉じる + CI(P0 / S)

- [x] **KO-01 pack retrieval scope の完全化** — 組織/プロジェクトを pack scope と tenant retrieval に伝播し、render と proximity テストを追加。
- [x] **KO-02 intent-contract 学習の tenant 化** — surface/task-session の学習呼び出しに `currentScope()` を渡した。
- [x] **KO-03 curation report の tenant 反復** — tenant registry 単位で usage を読み、legacy lane を分離表示。`scope_context_key` も保存する。
- [x] **KO-04 checker の PR CI 配線** — `ci.yml`/`pr-validation.yml` に `check:knowledge-scope` を追加し、境界テストを継続実行する。
- [x] **KO-05 scope_audit の可視化** — pack render と dispatch observability に拒否件数・理由コードを出力する。

### Wave 1 — 見える・切り替えられる・説明できる(P1 / S〜M)

- [x] **KO-06 `pnpm scope` と MCP `kyberion.scope.current`** — `ScopeResolution{scope, provenance, knowledge_roots}`、JSON 表示、MCP tool、doctor の tenant alias を実装。
- [x] **KO-07 `pnpm scope use` と区画付き focus** — `active/shared/runtime/scope.env` の use/show/clear と fallback 順を実装。stance fallback も除去。
- [x] **KO-08 ranker/retrieval の `--explain`** — scan 件数・除外件数・roots・警告を text/JSON に出し、Alignment 手順を更新。
- [x] **KO-09 空/欠落 scope のガイド付き失敗** — strict mode の confidential mission create/start に `[SCOPE_CONTEXT_INVALID]` と tenant 登録の hint を追加。
- [x] **KO-10 agent 側の境界原則** — working principles に tenant containment と scoped gap 記録の規則を追加。
- [x] **KO-11 `pnpm knowledge place`** — containment chain から frontmatter 付きの dry-run/apply scaffold を生成し、registered tenant を writer 側で再検証する。
- [x] **KO-12 Chronos scope breadcrumb と org/project セレクタ** — `ChronosTenantScope` の tenant › org › project selector、tenant-scope API の viewer-filtered options、workitems/operator-home/deliverables/TraceViewer の query 配線、各 panel header の active-scope 刻印まで実装。
- [x] **KO-13 人間のナレッジ feedback 経路** — CLI(`pnpm knowledge feedback`)/MCP/Chronos API+button/Slack reaction から useful/stale/wrong/not_useful を scoped JSONL と usage aggregate に記録する。Slack はメッセージ metadata または knowledge path marker がある反応だけを受理し、customer binding から tenant を解決する。

### Wave 2 — 自律ループ(P1〜P2 / S〜M)

- [x] **KO-14 silent gap の記録とクラスタリング** — low-score/empty の tenant retrieval を scoped gap lane に記録し、同一 scope/topic の3回目に既存 promotion queue へ候補を立てる。
- [x] **KO-15 scope 推論チェーン** — MISSION_ID の mission-state、cwd、git config の registered-format slug を provenance 付きで解決し、MCP binding では推論を無効化する。
- [x] **KO-16 usage-yield ranking と設定可能な proximity** — CLI ranker と共通 metadata scorer が governed `knowledge-weights.json` の defaults/tenant override を適用し、tenant usage aggregate から bounded な `usage_yield` weight proposal を物理 tenant runtime に出力する。提案は `approval_required=true` で、governance JSON を自動変更しない。承認後は `pnpm knowledge weights apply` が stale check、backup/history、変更 tenant override のみの書込み、audit 記録を行う。
- [x] **KO-17 staleness の自律提案と週次 sweep** — frontmatter `review_by` を尊重し、2 週連続の low-yield + freshness breach を archive advisory として履歴化し promotion queue へ積む。`wisdom:knowledge_validation_sweep` を weekly pipeline に追加し、heuristic/promotion queue の読み取り専用検査を行う。tier-hygiene と全体 reconciliation は `knowledge:scope-reconcile` で同じ週次 report に束ねる。
- [x] **KO-18 knowledge scope health watchdog** — 登録テナントの root existence と positive retrieval allowlist、unscoped feedback の増加を JSON/text で日次検査し、`--alert` で ops-alert へ記録できる `knowledge:scope-health` を追加。

### Wave 3 — 持続性(P2 / M)

- [x] **KO-19 区画の有界化・保全・移行** — backup/offboarding の区画、retention catalog、usage aggregate cap、feedback/intent/ledger/promotion migration の dry-run/apply + quarantine/report、semantic checker、週次 reconciliation report、promotion candidate の audit continuity 検査を実装。既存の unscoped legacy は所有権を推測せず quarantine 対象として残る。
      (a) `storage-retention-catalog.json` に intent-contract / compaction / partitioned audit / cowork-sync / `knowledge/personal/tenants` を登録し、`ingest-quota` の `tenant_overrides` 形で区画別 quota・usage aggregate cap。
      (b) `backup.ts` の `TENANT_PHYSICAL_BACKUP_ROOTS` と `scope-offboarding.ts` probe に新区画を追加(offboarding で学習データが残らない)。
      (c) `migrate_physical_namespaces.ts` に `feedback|intent|ledger|promotion` kind(plan/apply + quarantine)、`knowledge:scope-reconcile` の disposition 別件数 report、`unscoped-legacy` の増加・TTL監視を実装。今回確認済みの legacy feedback 13件、global intent 1件、global promotion queue 1ファイルは hash 検証付きで quarantine apply 済み。未分類データを tenant へ auto-apply は行わない。
      (d) `check:audit-continuity` の report に tenant-scoped promotion candidate の `audit_ref` と master audit chain の照合を追加。legacy unlinked は観測値として残し、壊れた参照だけを失敗にする。
      (e) KS-16 checker を semantic 化: unscoped `buildScopedIndex`、tenant source 無しの confidential scope、`process.env.KYBERION_TENANT` 直読みの baseline ratchet を検査する。promotion queue は tenant shard writer に移行し、weight proposal は steward apply ceremony として実装した。scoped runtime writer の物理 namespace ratchet、curation history の tenant shard 化、legacy quarantine TTL 監視も追加した。
      (f) `KYBERION_HINTS_PATH` 流用の分離、scoped runtime writer の physical namespace checker、`multi-tenant-operations.md`・`CAPABILITIES_GUIDE`・`pipelines/README` 更新、`IMPLEMENTATION_LEDGER` 登録。

## 実装順序と依存

| 順  | 項目                       | 依存                                                | 規模         |
| --- | -------------------------- | --------------------------------------------------- | ------------ |
| 1   | KO-01〜05(Wave 0)          | なし                                                | S・並列可    |
| 2   | KO-06 → KO-07 → KO-15      | なし(KO-06 の `ScopeResolution` を KO-07/15 が使う) | S→M→M        |
| 3   | KO-08, KO-09, KO-10, KO-11 | KO-06                                               | S〜M・並列可 |
| 4   | KO-12, KO-13               | KO-06(表示構造)、KO-13 は KO-03                     | M            |
| 5   | KO-14 → KO-16 → KO-17      | KO-03(tenant 別 usage が読める)                     | S+M / M / M  |
| 6   | KO-18                      | KO-14, KO-16(信号がある)                            | M            |
| 7   | KO-19                      | 全て(移行対象が確定)                                | M            |

## 受け入れ条件

1. `pnpm scope --json` と MCP `kyberion.scope.current` が同一の `{scope, provenance, knowledge_roots}` を返し、各フィールドの出所が明示される。
2. `pnpm scope use --tenant A --project P` 後の `pnpm knowledge:rank --explain` が active roots と `excluded_by_scope` 件数を出力し、`mission-state.json` のみの環境でも `MISSION_ID` から同じ scope が推論される(provenance=`mission-state`)。
3. pack render に `Scope-rejected knowledge` 行が出て、dispatch observability の件数と一致する。同 project 配下 doc が pack で common doc より上位。
4. tenant A の intent-contract outcome / usage / gap 記録が tenant B の候補選択・ranking・curation report に一切現れない。
5. tenant retrieval が空だったミッションは gap lane に記録され、3 回以上で promotion queue に ingest 提案候補が 1 件立つ(自動起票・承認は手動)。
6. `watch_knowledge_scope_health --alert` が空 tenant / proximity 停滞 / legacy 増加を warning として出す(fixture で固定)。
7. `check:knowledge-scope` が PR CI で走り、unscoped `buildScopedIndex`、tenant source なしの confidential scope、`env.KYBERION_TENANT` 直読みの増加のいずれでも赤になる。
8. `backup --scope tenant` と offboarding dry-run の probe が新区画をすべて含み、retention catalog に登録漏れの scoped root が無い(checker で固定)。
9. `mission create --tier confidential` が tenant 無しで是正案付きに失敗し、`[SCOPE_CONTEXT_INVALID]` に `hint:` が付く。
10. usage-yield / proximity の重みを 0 にすると KS 実装時の順位と一致する(ロールバック可能性)。

## 非目標

- 新しい承認 UI・承認ワークフローの新設(既存 KM-03 queue / ingest ceremony / apply confirmation を再利用)。
- ranking アルゴリズム自体の刷新(embedding 統一は KM-02 の管轄)。
- cross-tenant 匿名化 pattern 昇格(`promotion_policy: brokered`)の本実装 — 本計画では KO-17 の提案経路に候補種別として枠のみ用意し、PII scrub と ingest-tier-gate の再利用設計は別計画(L)。
- `KYBERION_VIEWER_SCOPE` 既定の `enforce` 化。

## リスク・注意

- KO-09 の confidential mission tenant 必須化は既存スクリプト/テスト fixture の `tenantId:'default'` 依存を壊し得る。`KYBERION_TENANT_SCOPE_REQUIRED` を段階フラグとして先に warn → 次に fail に上げる。
- KO-15 の推論は誤 tenant を選ぶと隔離事故になる。cwd/git 推論は tenant registry に登録済み slug に一致した場合のみ採用し、tier は絶対に広げない。provenance を必ず出す。
- KO-16 の usage-yield は自己申告 usage に依存する。KO-13(人間 feedback)より先に重みを上げない。既定重みは小さく、`knowledge-weights.json` は governed artifact として diff 可能に。
- KO-19(c) の auto-apply は governed cap と mission-state authority が生きている場合に限定。cap 超過・authority 消失は steward list へ。

## 関連

- [KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16](../improvement-plans-archive/2026-08/KNOWLEDGE_SCOPE_ALIGNMENT_PLAN_2026-08-16.ja.md)(前提・隔離)
- [KM-03_PROMOTION_GOVERNANCE_LOOP](../improvement-plans-2026-07/KM-03_PROMOTION_GOVERNANCE_LOOP.ja.md) / [KM-04_KNOWLEDGE_STORE_HYGIENE](../improvement-plans-2026-07/KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md)
- [TENANT_DATA_ACTIVATION_PLAN_2026-07-28](../improvement-plans-2026-07/TENANT_DATA_ACTIVATION_PLAN_2026-07-28.ja.md)(DA-08 curation / ingest ceremony)
- [ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)(scope-migration / physical namespace)
- [LIFECYCLE_SMOOTHNESS_PLAN_2026-08-08](./LIFECYCLE_SMOOTHNESS_PLAN_2026-08-08.ja.md)(改善ループ信号品質)
- `scripts/watch_tenant_drift.ts` / `pipelines/tenant-drift-watch.json`(KO-18 の雛形)、`pipelines/knowledge-curation-weekly.json`(KO-03/14/16/17 の実行基盤)

## 実装状況

- 2026-08-17: KO-16 の tenant 別 bounded weight proposal、steward apply ceremony(stale check/backup/history/audit)、KO-17 の validation sweep pipeline、KO-19 の intent/ledger/promotion migration、tenant-sharded promotion queue、tenant-scoped curation history、promotion audit continuity、semantic checker、legacy quarantine TTL、weekly reconciliation report まで実装。既存の legacy feedback 13 件、global intent memory 1 件、global promotion queue 1 ファイルは hash 検証付きで quarantine apply 済みで、tenant 所有権を推測する移行は行っていない。
