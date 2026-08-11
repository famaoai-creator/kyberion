---
title: Entity Governance Unification Plan 2026-08-09
tags: [governance, tenant, organization, project, mission, artifact, lifecycle, audit, registry]
last_updated: 2026-08-09
status: active
---

# エンティティガバナンス統一計画(EG-01〜13)

## 1. 背景

Kyberion はミッションを中核に進化してきた。その結果、ミッションだけが完全な state machine・スキーマ検証・監査・アーカイブ・CI ゲートを備え、**後から追加されたテナント・組織・プロジェクト・成果物(アーティファクト)・ワークアイテムは、同じ水準のガバナンスを受けていない**。2026-08-09 に read-only 全域監査(コード側の執行実態 / ディスク上の状態実態 / 既存計画の被覆状況)を実施した結論は次の一文に要約できる。

> **執行成熟度は「ミッション > プロジェクト > 組織 > ワークアイテム > テナント」の順に急落する。全エンティティにスキーマは存在するが、テナントには write facade が存在せず、組織はアーカイブ不能で監査記録ゼロ、ワークアイテムの正準 context chain はスキーマ未適用・参照整合性検証ゼロであり、正準スコープ階層そのものが文書間で矛盾している。**

本計画は置き換え計画ではない。[ARTIFACT_AGENT_LIFECYCLE_NHI_PLAN](../improvement-plans-2026-07/ARTIFACT_AGENT_LIFECYCLE_NHI_PLAN_2026-07-26.ja.md)(AL/NI、完了)が確立した「**階層は 1 つ、消費面は複数**」の原則と、ミッションが既に達成している執行水準を**残り全エンティティへ対称に拡張**する計画である。

### 既存計画との棲み分け

| 既存計画                                                                                                                                                                          | 被覆済み                                                         | 本計画が引き取る残余                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| AL/NI(完了)                                                                                                                                                                       | 保持カタログ・NHI 識別・offboard 動詞                            | mesh-hub / pipeline-runs / run-graphs の保持未被覆(DA-08 記載の既知ギャップ)                                                   |
| [ORGANIZATION_VIEW_SCOPE_ARCHITECTURE](../improvement-plans-2026-07/ORGANIZATION_VIEW_SCOPE_ARCHITECTURE_2026-08-04.ja.md)                                                        | WorkItem 正準化・view 射影                                       | 「次の移行段階」4 項(typed context バックフィル、作成経路契約、レガシーフォールバック除去、TASK_BOARD 状態統合 = 未追跡 MO-09) |
| [LIFECYCLE_SMOOTHNESS_PLAN](./LIFECYCLE_SMOOTHNESS_PLAN_2026-08-08.ja.md) LC-09/10/11                                                                                             | context chain の CLI 接続、facade 命名整理、mission hygiene 掃除 | 掃除の**再発防止機構**(生成源の封鎖・CI ゲート)と hygiene 対象のエンティティ横断拡大                                           |
| [ORGANIZATION_OPERATING_MODEL_PLAN](./ORGANIZATION_OPERATING_MODEL_PLAN_2026-08-03.ja.md) / [PROJECT_MANAGEMENT_CONTROL_PLAN](./PROJECT_MANAGEMENT_CONTROL_PLAN_2026-08-03.ja.md) | authoring facade・CRUD の存在                                    | ライフサイクル動詞の欠落(組織の retire 不能)・監査記録・参照整合性                                                             |
| [WORK_GRAPH_EXECUTION_UNIFICATION](../improvement-plans-2026-07/WORK_GRAPH_EXECUTION_UNIFICATION.ja.md)(未追跡)                                                                   | 実行グラフ統一の設計                                             | STATUS 台帳への登録(EG-13)                                                                                                     |
| [VISIBILITY_SCOPE_AUTHZ_PLAN](../improvement-plans-2026-07/VISIBILITY_SCOPE_AUTHZ_PLAN_2026-08-05.ja.md)(PARTIAL)                                                                 | HTTP viewer scope                                                | (残余は同計画側で完結。本計画はストレージ側境界のみ扱う)                                                                       |

## 2. 監査結果(エビデンス)

### 2.1 執行成熟度マトリクス(コード実態)

|                        | Missions                  | Projects                     | Organizations            | Tenants                      | Work items        |
| ---------------------- | ------------------------- | ---------------------------- | ------------------------ | ---------------------------- | ----------------- |
| Write facade           | ✅ `pnpm mission`         | ✅ `pnpm project`            | ✅ `pnpm organization`   | ✅ `pnpm tenant`             | ✅ `pnpm work`    |
| 書き込み時スキーマ検証 | ✅ Ajv 全 save            | ✅                           | ✅(16 schema)            | ✅ facade                    | ✅ WorkItem Ajv   |
| ID 形式検証            | ✅(部分)                  | ✅ `PRJ-`                    | ✅                       | ✅ slug                      | ✅ schema/context |
| State machine 執行     | ✅ 明示遷移表             | ⚠️ ガードのみ                | ✅ pause/resume/archive  | ✅ active/suspended/archived | ⚠️ status         |
| アーカイブ動詞         | ✅ policy sweep + receipt | ⚠️ soft のみ                 | ✅ archive/retire/remove | ✅ archive                   | ⚠️ status         |
| 監査チェーン記録       | ✅                        | ✅                           | ✅ `organization.*`      | ✅ `tenant.*`                | ✅ `work_item.*`  |
| リンク先の参照検証     | ⚠️ 形式のみ               | ✅ tenant/org + inverse link | ✅ project refs          | n/a                          | ✅ typed context  |
| CI ゲート              | ✅ baseline               | ✅ entity checker            | ✅ entity checker        | ✅ `check:tenant-registry`   | ✅ entity checker |

一次エビデンス(主要なもの):

- テナント(起草時): `writeTenantProfile()`の呼び出しと status 執行が不足していた。現在は `pnpm tenant` facade、status gate、`knowledge_root` 初期化、監査、手順更新を実装済み。
- 組織: 初期監査時は動詞が欠落していたが、現在は `pnpm organization pause|resume|archive|retire|remove` と `auditChain` を接続済み。残りは現存状態木の裁定と受入証跡。
- ワークアイテム: 初期監査時は schema が dead code だったが、現在は `work-item.schema.json` を Ajv 執行し、typed context を writer/filter/audit へ接続済み。旧 `metadata.*`/`mission:` 表現は one-time `migrate-context` adapter だけに隔離している。
- セキュリティ境界の矛盾(起草時): `active/missions/confidential/` と `active/projects/confidential/` が protected prefix から欠落していた。現在は両方を追加し、org CLI の security-policy 直書きを human-only approval に限定した。
- 生成機構の欠陥(起草時): `path-resolver.ts` の read path が mkdir 副作用を持っていた。現在は `rawMkdirp` を resolver から除去し、mission ID guard と secure-io writer 境界を実装した。
- チェッカーの自己無効化(起草時): project registry の tenant 突合と entity tree 走査が不足していた。現在は project registry tenant を収集し、entity checker が organizations/projects/missions、workspace registry、mission hygiene、git boundary を検査する。

### 2.2 ディスク実態(ルールと状態の乖離)

- **テナント**: `knowledge/confidential/` 配下に**テナントディレクトリが 1 つも存在しない**。レジストリ参照は全て宙ぶらりん(`kyberion-service-studio.json` の `knowledge_root` 先も不存在。この項目はチェッカー未検証)。`check:tenant-registry` は**現時点でローカル fail**(孤児 `customer/` 5 件: `e2e-onboard-1`, `ops-org`, `story-demo`, `story-e2e-1`, `story-migrate`)+ 陳腐化 exception 3 件(`client-a/b/new`)。チェッカー死角に未登録テナント風スラッグ 4 件(`tenant-acme`, `tenant-x`, `acme`, `tenant-alpha`)。`knowledge/confidential/tenant-groups/` は空で、group `shared_prefixes` 判定は常に `tenant.group_unknown` で fail-closed。
- **ミッション**: `archived` 39 + `completed` 6 + `failed` 8 件が `active/missions/` に残留(`mission-lifecycle.json` 違反)。ポリシーが定める `failed_missions/` は不存在。tier 外ルート直下に 4 件、非設定 tier `ephemeral/` に 3 件(controller から不可視)。argv 誤解釈由来の `--HELP/`・`--ID/` が本物のミッションとして実体化(各自 `.git` 持ち)。同一 ID の tier 重複 10 件、active/archive 重複 19 件(status 相違)、`mission-state.json` 欠落 39 件(テストフィクスチャ漏出)。
- **プロジェクト**: workspace 90 ディレクトリ vs レジストリ 5 レコード。ミッション ID がプロジェクト ID として使用(`MSN-KP05-TRACE-*` 約 25 件ほか)。未展開テンプレート `{{project_name}}/` が `.git` 付きで実体化。README 宣言レイアウト違反の非 tier 直下ディレクトリ 4 件。`tenant_slug: "shared"` という sentinel が confidential 必須制約を素通し。
- **成果物**: ミッション成果物の終着点は mission-local `evidence/` で、knowledge/ への蒸留は 356 ミッション中約 40 件、`distilling` 滞留 58 件。**蒸留先が 2 箇所に分裂**(`knowledge/product/evolution/` = tracked と `knowledge/evolution/distill_*.md` = gitignore され manifest 外 → 7 件の蒸留知識が永久に未コミット)。`ArtifactOwnershipRecord` に `tenant_slug`/`organization_id` が無く、テナントの成果物列挙が不能(offboard はパス走査で補償)。`active/shared/exports` は**リポジトリ外へのシンボリックリンク**(`/Volumes/data/kyberion-work/exports`)。
- **運転停止の兆候**: `active/audit/` の最終ファイルは `audit-2026-05-31.jsonl` — **監査台帳が約 10 週間停止**したまま系は稼働継続。`active/shared/tmp/` は 2.6 GB / 432 件(2026-05-08 起源の残留あり)で、janitor はあるが常駐運転されていない(LC-01 の帰結)。
- **git 境界**: `knowledge/personal/`・`vault/` は gitignore 対象なのに tracked ファイルが混在。`*.jsonl` の全域 ignore が監査台帳・execution-ledger まで暗黙に被覆。`active/` が 2 回 ignore 宣言。ネストした `.git` が `active/` 配下に 306 個(git ベースの統制スイープから全て不可視)。

### 2.3 正準の分裂

スコープ階層の正準が文書間で矛盾している:

- `ORGANIZATION_VIEW_SCOPE_ARCHITECTURE`: `organization_id → tenant_slug → mission_id → project_id → task_id`
- AL/NI・`path-resolver`・`tier-guard`・保持カタログ: `tenant → project → mission → task → session`

**project と mission の包含順すら一致していない。** ディスクレイアウト(`active/organizations/{tier}/{tenant}/{org_id}`、`active/projects/{tier}/{tenant_or_shared}/{project_id}`)と [project-mission-artifact-service-model](../../../knowledge/product/architecture/project-mission-artifact-service-model.md)(Project = 意味の容器、Mission は Project に従属)は後者系を支持する。

## 3. 目的

1. **対称性**: 全エンティティ(テナント・組織・プロジェクト・ミッション・ワークアイテム・成果物)が同一水準の統治を受ける — facade 経由の変更、書き込み時スキーマ検証、生きた status、アーカイブ/リタイア動詞、監査チェーン記録、参照整合性、CI ドリフト検知。
2. **単一の正準**: スコープ階層の順序を 1 つに確定し、全消費面(配置・アクセス制御・保持・識別・WorkItem context・view 射影)を追従させる。
3. **fail-visible**: 統治外の状態(未登録スラッグ・孤児・残留)は黙認せず検知・可視化する(AR-06 の思想を状態木全体へ)。
4. **一回性の掃除と恒久機構の分離**: 現存する乖離の清算(ミッション)と、再発を防ぐ執行機構(コード + CI)を別項目として管理する。

### 非目標

- HTTP viewer scope の enforce 移行(VISIBILITY_SCOPE_AUTHZ が完結させる)
- knowledge/ tier 昇格ガバナンスの変更(KM の領分。蒸留**先の一本化**のみ扱う)
- 外部 IdP・OS ユーザ分離(multi-tenant-operations §11 の既知限界のまま)
- 実行グラフ統一の実装(WORK_GRAPH_EXECUTION_UNIFICATION の領分。本計画は台帳登録のみ)

## 4. 原則

1. **階層は 1 つ、消費面は複数**(AL/NI 原則 1 の再確認)。新しい階層は発明しない。順序の矛盾は解消する。
2. **facade の対称性**: エンティティを作れる経路には必ず(a)スキーマ検証、(b)参照整合性検証、(c)監査記録が付く。読み取りの副作用でディレクトリが生まれることはない。
3. **status は読まれて初めて存在する**: schema にある status を読むコードパスが無いなら、それは統治ではなく飾りである。suspended なテナントでの操作は拒否されなければならない。
4. **チェッカーは自分の死角を申告する**: 走査対象外のプレフィックスを持つ整合性チェックは、その旨をレポートに明記する。

## 5. 改善項目

### Phase 1 — 境界の修復(P0)

- **EG-01 正準スコープ階層の一本化**
  正準を `tenant_slug → organization_id → project_id → mission_id → task_id → session` に確定する(ディスクレイアウトと project-mission-artifact-service-model に整合。organization は tenant 配下の運用状態であり、WorkItem context の `organization_id` 先頭表記は「フィールド列挙順」であって包含順ではなかったことを明文化)。正本文書を 1 つ定め(`knowledge/product/architecture/` 配下)、ORGANIZATION_VIEW_SCOPE_ARCHITECTURE・AL/NI 系文書へ相互参照を張り、包含順の conformance テスト(path-resolver / tier-guard / 保持カタログ / `AgentIdentity.affiliation` / `WorkItemContext` が同一順序を語ること)を追加する。
  受入: 矛盾していた 2 文書が同一正本を参照。conformance テスト緑。

- **EG-02 テナント保護プレフィックスの完全化(セキュリティ境界内の文書 vs 設定矛盾の解消)**
  (a) `security-policy.json` の `tenant_scope.protected_prefixes` に `active/missions/confidential/` と `active/projects/confidential/` を追加。(b) 越境書き込みが拒否され `tenant.broker_access` 監査イベントが出ることの回帰テスト。(c) `scripts/org.ts` が `security-policy.json` を直接書き換える経路に承認ゲート(approval-store の human-only 承認)を課す — tier-guard が読む正本を無承認で変更できる現状は権限昇格経路である。
  受入: 越境 write の deny + audit の 2 tier(missions/projects)× 2 方向テスト緑。security-policy 直書きは承認なしで失敗する。

- **EG-03 監査台帳停止の調査と復旧**
  `active/audit/` が 2026-05-31 で停止した原因を特定し復旧する。復旧後、baseline-check に「監査台帳の鮮度」レイヤを追加し、最終エントリが閾値(例 48h)より古い場合 `needs_attention` を返す — 系が動いているのに監査が止まる状態を二度と黙認しない。
  受入: 監査書き込みが再開し、鮮度チェックが baseline-check レポートに現れる。停止期間は原因と共に記録(必要なら system-ledger に gap 宣言)。

- **EG-04 生成源の封鎖 — path-resolver の mkdir 副作用を secure-io 経由へ**
  `path-resolver.ts` の `rawMkdirp` 9 箇所を廃し、(a)読み取り経路はディレクトリを作らない、(b)作成は書き込み操作として `validateWritePermission` を通す、に分離する。あわせて mission ID ガード(`assertMissionIdArgument`)を `pathResolver.missionDir` 側でも適用し、`--HELP` 型の実体化を機構的に不能にする。
  受入: `--ID` 相当の引数でディレクトリが生成されないことのテスト。既存呼び出し全数の read/write 分類レビュー。

### Phase 2 — facade と検証の対称化(P1)

- **EG-05 作成時参照整合性の全エンティティ適用**
  mission / project / organization / work-item の作成経路が `resolveTenant()` を呼び、未登録テナント・`suspended`/`archived` テナントを拒否する(EG-07 の status 活性化と連動)。project ID に形式規則(`PRJ-` 接頭辞 + 文字集合)を導入し、ミッション ID の流用を拒否。`project create --organization-id` は組織の実在を検証し、組織側 `active_project_ids` への逆リンクを同一トランザクションで書く(現状の片方向執行を解消)。confidential tier での `tenant_slug: "shared"` は「共有」の明示意図フラグと分離し、sentinel による必須制約素通しを塞ぐ。
  受入: 4 エンティティ × (未登録 / suspended テナント) の拒否テスト。双方向リンクの reconcile テスト。

- **EG-06 WorkItem context のスキーマ執行とレガシー表現の除去**
  `work-item.schema.json` に `context`(EG-01 の正準順)と `work_shape` enum を定義し、`createWorkItem` で Ajv 適用(CLI 以外の呼び出し元にも効かせる)。ORGANIZATION_VIEW の移行段階を引き取る: (1) `metadata.mission_id`/`mission:` label の typed context へのバックフィル、(2) 作成 CLI・外部 sync 入力契約への `context` 必須化、(3) `quality.migrated_context` が 0 になった時点でフォールバック解釈(`work-coordination.ts:769,779-795`)を削除。TASK_BOARD 状態の WorkItem 射影への統合(未追跡 MO-09)はここに含める。work-item 変更を auditChain へ記録する。
  受入: schema 適用テスト。バックフィル後 `quality.migrated_context = 0`。フォールバックコード削除。

- **EG-07 テナント write facade と status の活性化**
  `pnpm tenant` を新設(`create / update / suspend / resume / archive / list / show`)。内部は既存の `writeTenantProfile()` を使い、Ajv + slug 検証 + auditChain 記録 + `--dry-run|--apply` 二択(organization facade と同じ不変条件)。`resolveTenant()` が `status` を読み、suspended/archived で fail-closed。`tenant-onboarding-procedure.md` を facade 経由手順へ書き換え、手動 JSON 編集手順を廃止。profile の `knowledge_root` 実在(または初期化)も facade が保証する。
  受入: 手動編集なしで新テナントが end-to-end で作成でき、suspend 中の操作が拒否される。

- **EG-08 組織のライフサイクル動詞と監査**
  `pnpm organization` に `archive / pause / resume` と、kind 単位の `retire`(domain / capability / service / operation / cadence)、および `remove`(参照残存時は fail-closed)を追加。全 mutation を auditChain に記録(project-management と同水準)。retire 済み組織への `add` 系は拒否。
  受入: 全動詞の遷移テスト。auditChain に `organization.*` レコードが残る。

- **EG-09 ドリフト検知の対象拡大と CI ゲート**
  (a) `check_tenant_registry_consistency.ts` の陳腐化注記を修正し project↔tenant 突合を有効化。走査対象に `active/{organizations,projects,missions}/` のテナントセグメントと profile の `knowledge_root` 実在を追加。走査不能領域(CI に gitignore データが無い問題)はレポートに死角として明記し、ローカル/デーモン実行時のみ全域走査する 2 モード化。(b) project registry↔workspace の双方向 reconciler(90 vs 5 の乖離を検知し、未登録 workspace を列挙)。(c) mission hygiene チェック(LC-11 の掃除に対する再発防止側): tier 外配置・tier 重複・active/archive 重複・state 欠落・非正規 ID を検知するチェックを新設し、`pnpm verify` 系または CI に接続。
  受入: 現存の既知乖離が全て検知される(fixture 化)。CI で緑を維持する運用ルールを README に記載。

### Phase 3 — 成果物・状態木の清算(P2)

- **EG-10 成果物の帰属と保持の統一**
  `ArtifactOwnershipRecord` / `artifact-record.schema.json` に `tenant_slug` と `organization_id` を追加(EG-01 の正準順で)。offboard のパス走査補償をレジストリ照会へ置換。保持カタログの未被覆(mesh-hub / pipeline-runs / run-graphs — DA-08 既知ギャップ)を宣言し TTL を設定。`active/shared/exports` のリポジトリ外 symlink は、(a)保持カタログに external mount として宣言するか(b)リポジトリ内へ戻すかを決定(推奨: 宣言 + offboard 走査対象化)。蒸留先を `knowledge/product/evolution/` に一本化し、`knowledge/evolution/distill_*.md` の gitignore 特例を廃止して既存 7 件を移送・manifest 登録する。
  受入: テナント指定で成果物が列挙できる。保持カタログに未宣言の runtime サブツリーが無い(または顕在化リストに載る)。

- **EG-11 一回性クリーンアップ・ミッション**
  現存乖離の清算は**ミッションとして**実施する(dog-food 規則: 統制証跡そのもの)。対象: `--HELP`/`--ID` ミッション除去(LC-11 残)、tier 重複 10 件と active/archive 重複 19 件の裁定、tier 外ルート 4 件 + `ephemeral/` 3 件の正規 tier への編入または廃止、state 欠落 39 件(テストフィクスチャ)の除去とテスト側の出力先隔離、`{{project_name}}/` と非 tier プロジェクト 4 件の正規化、孤児 `customer/` 5 件と陳腐化 exception 3 件の裁定、未登録スラッグ 4 件(`tenant-acme` 等)の登録または廃止、`active/` 直下と `active/shared/` 直下の野良ファイル、`active/sim-test/`、`outputs/`・`work/`・`vault/` のパッチ置き場化の解消。各裁定は mission evidence に記録する。
  受入: EG-09 の検知器がゼロ検知になる(検知器を先に入れ、掃除の完了判定を検知器に委ねる)。

- **EG-12 git 追跡境界の整合**
  gitignore 対象ディレクトリ内の tracked ファイル(`knowledge/personal/` 3 件、`vault/mounts/.gitkeep`)の意図を裁定し、意図的なら negation パターンで明示(`customer/` の精密 negation が手本)。`*.jsonl` 全域 ignore を範囲限定に置換(監査台帳・execution-ledger を暗黙に覆う現状の是正 — ignore 自体は正しくても、範囲は宣言的であるべき)。`active/` の重複宣言統合。
  受入: `git status --ignored` ベースの境界テストが宣言と一致。

- **EG-13 計画台帳の統治**
  STATUS 台帳(2026-07)に未登録の約 20 計画(`WORK_GRAPH_EXECUTION_UNIFICATION`、`ORGANIZATION_VIEW_SCOPE_ARCHITECTURE`、E2E-01〜06、MO-09 ほか)へ行を追加し、状態を実コードと突合して記入する。2026-08 系(文書内「実装状況」節方式)との二重規約を README に明文化し、新規計画は**作成時に**索引へ登録することを規約化する(本計画は作成時に索引登録済み)。
  受入: 台帳 grep で未登録計画ゼロ。

## 6. 実装順序と依存

| Phase | 項目      | 依存・備考                                                                                                    |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------- |
| 1(P0) | EG-01〜04 | 相互独立。EG-02/03 はセキュリティ・監査の穴であり最優先。EG-04 は EG-11 の前提(生成源を塞いでから掃除)        |
| 2(P1) | EG-05〜09 | EG-05 は EG-01(正準確定)と EG-07(status 活性)に依存。EG-06 は EG-01 依存。EG-09 は独立だが EG-11 の完了判定器 |
| 3(P2) | EG-10〜13 | EG-11 は EG-04・EG-09 の後(塞いでから・検知器を立ててから掃除)。EG-10 は offboard 回帰(AL-04)を必ず再実行     |

## 7. リスク・注意

- **EG-02 の protected_prefixes 追加は既存の正当な越境フローを破壊しうる**。warn → enforce の段階導入(`KYBERION_VIEWER_SCOPE` と同じ流儀)で、warn 期間の監査観測を経てから enforce する。
- **EG-04 の read/write 分離**は「読み取りが暗黙にディレクトリを保証する」前提の既存呼び出し元を壊しうる。呼び出し全数レビューと、書き込み直前 `ensure` への移設を機械的に行う。
- **EG-05 の resolveTenant 必須化**は、既存の未登録スラッグ(`tenant-x` 等)上で動いているフローを止める。EG-11 の裁定(登録 or 廃止)を先行または同時に行う。
- **EG-06 のフォールバック除去**は `quality.migrated_context = 0` の実測を必須条件とし、日付では切らない。
- **EG-11 は破壊的操作を含む**ため、mission 化 + dry-run 既定 + 裁定記録を必須とし、`.trash/` soft-delete(offboard と同機構)経由で復元可能に行う。
- テナントディレクトリが現在ゼロである事実は「移行が容易」を意味する — 実データが載る前に境界を完成させることが本計画の時間的意義である。

## 8. 実装状況

- 2026-08-09: 計画起草(read-only 監査 3 系統に基づく)。
- 2026-08-09: Phase 1〜3 の実装基盤を追加。正準スコープ実行定数、tenant/project/work-item/organization 境界、tenant facade、組織 lifecycle、artifact/retention、drift checker、cleanup mission、git boundary を実コードへ接続。13ファイル132テスト、core build/typecheck、baseline pipeline、WorkItem migration の `quality.migrated_context = 0`、計画台帳の `missing = []` を確認。登録済み workspace 不在5件は archive 済み。
- 2026-08-11: EG-11 の cleanup apply を approval-store の `mission_gate` に接続。対象 findings の payload hash、effect binding、認証済み human workflow、dry-run/fixture apply をテストで固定。実ツリーの mission/project/distill 裁定・soft-delete 適用は、引き続き個別の人間承認を要する。
