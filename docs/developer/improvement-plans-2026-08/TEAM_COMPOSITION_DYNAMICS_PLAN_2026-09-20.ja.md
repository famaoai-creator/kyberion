---
title: ミッションチーム編成の動的化計画
tags: [improvement-plan, 2026-08, mission, team-composition, orchestration]
last_updated: 2026-09-20
status: active
---

# ミッションチーム編成の動的化計画 (TC-01〜TC-14)

**ミッション**: `MSN-TEAM-COMPOSITION-20260920`
**起点の問い**: 「チーム構成が JSON で固定的に紐づいている。オーケストレータが柔軟にリソースプールからチームを組成するほうがよいのではないか」

## 0. 結論(先に)

**「テンプレート固定 vs LLM 自由組成」は正しい対立軸ではない。** 現状はすでに半分プール選抜であり、本当に固定なのは _役割集合_ と _充当タイミング_ の 2 点である。したがって本計画は次の形を採る。

> **制約(envelope)は宣言的に導出し、充当(staffing)は需要駆動にする。LLM は提案者に限定し、既存の policy / authority / SoD 検証を通過したものだけを commit する。**

これは本リポジトリが ADF(`draft → preflight → auto-repair → commit → execute`)と creative brief(semantic brief + design cascade)で既に採っている形と同一であり、新しい統治概念を持ち込まない。

## 1. 現状監査(2026-09-20 実測)

### 1.1 どこが静的で、どこが既に動的か

| 層                 | 実体                                                                                          | 静/動  |
| ------------------ | --------------------------------------------------------------------------------------------- | ------ |
| ミッション分類     | `resolveMissionClassification`(`mission_class` / `delivery_shape` / `risk_profile` / `stage`) | 動     |
| **役割集合**       | `knowledge/product/orchestration/mission-team-templates.json`(12 テンプレート)                | **静** |
| 役割 → アクター    | `libs/core/team-role-assignment-selection.ts` `selectAgentForTeamRole`                        | 動     |
| **充当タイミング** | `composeMissionTeamPlan` が mission 作成時に全役割を一括確定                                  | **静** |
| 実体化(spawn)      | `mission-team-orchestrator.ts` `ensureMissionTeamRuntime`(`teamRoles` フィルタ可)             | 半動   |
| タスク → 担当      | planner が `assigned_to.role` を出し、dispatch が必要ロールのみ prewarm                       | 動     |

`selectAgentForTeamRole` は既にプールからのスコアリング選抜である: capability 一致 ×10 / 未充足 −2、role 側 `preferred_agents` +20、職務分離ペナルティ(同一アクター −24・同一プロバイダ −6)、実績フィードバック ±8(`agent-performance-index`・`model-performance-index`)、`authority_role` の `scope_classes` 未充足は候補から除外。選定理由は `selection_reason_codes` として plan に残る。

### 1.2 実測された痛み(baseline: `MSN-TEAM-COMPOSITION-20260920`)

`mission_controller create MSN-TEAM-COMPOSITION-20260920 --tier public` の生成物:

- 分類: `code_change` / `single_artifact` / `review_required` / `intake`
- 選択テンプレート: `development`
- **staffing-assignments.json に 8 名が `active`**(owner, orchestrator, planner, implementer, reviewer, tester, operator, surface_liaison)
- 一方 `NEXT_TASKS.json` の 8 タスクが要求する役割は **planner / implementer / reviewer の 3 つだけ**

すなわち `tester` / `operator` / `surface_liaison` は、**一度も仕事を割り当てられないまま staffing レコードと NHI provisioning を持つ**。`optional_roles` すら常に充当されるのが現在の意味論である(`mission-team-plan-composer.ts` の `for (const role of template.optional_roles)` は無条件に `selectAgentForTeamRole` を呼ぶ)。

### 1.3 プールの厚み(候補数の実測)

```
orchestrator 1  |  implementer 2  |  devils_advocate 1  |  counterparty_persona 1
facilitator 2   |  scribe 2       |  tracker 2          |  experience_designer 2
attacker 3      |  defender 3     |  operator 3         |  owner 3
reviewer 3      |  researcher 3   |  tester 3           |  product_strategist 3
planner 5       |  surface_liaison 8
```

agent profile は 17 件、うち 7 件が surface 系。**組成アルゴリズムを賢くしても選択肢が無い役割が多い**。いま効くのは組成の自由度ではなく、役割集合の導出とプールの厚み・メタデータ解像度である。

### 1.4 書かれているが接続されていない層

- `libs/core/worker-assignment-policy.ts`(135 行、lease 数 / 並行タスク数 / scope 衝突を見るタスク→ワーカー割当)は `index-part-09.ts` から export されているだけで**本番の呼び出し元が 0**。
- `WorkforceResourceRef.availability` は `{ status: 'available' }` のベタ書き、`cost_profile` は `{}`(`mission-team-binding.ts`)。**プールに容量・コスト信号が無い**。

## 2. 根本原因

1. **役割集合がバケツ名(mission_type)由来で、義務(obligation)由来ではない。** risk_profile が `review_required` でも、reviewer が入るのは「テンプレートにたまたま書いてあるから」であり、統治上の要件として導出されていない。テンプレート追加でしか新しい仕事の形に対応できない。
2. **plan = 名簿 = 稼働メンバー、という三重の同一視。** 名簿に載ることと、いま働くことが区別されていない。結果、名簿を小さくする圧力と、必要な役割を漏らさない圧力が正面衝突する。
3. **組成が一回きり。** `resolveMissionTeamPlan` は既存 plan があればそのまま返し、`forceRefresh` 以外に再編成経路が無い。ミッション途中で要求 capability が変わっても編成は変わらない。
4. **プールの状態(空き・コスト・実績)が選抜に届いていない。**

## 3. 項目一覧

| ID    | 区分 | 内容                                                                                                  | 優先度 |
| ----- | ---- | ----------------------------------------------------------------------------------------------------- | ------ |
| TC-01 | B    | 充当状態 `standby` の導入。plan は名簿 + 封筒、staffing は staffed のみ                               | P0     |
| TC-02 | B    | 需要駆動の昇格(standby → assigned)を `ensureMissionTeamRuntime` に接続し、執行台帳へ記録              | P0     |
| TC-03 | A    | 義務ポリシーカタログ `team-composition-obligations.json` と導出器                                     | P0     |
| TC-04 | A    | 役割集合 = テンプレート ∪ 義務導出。`role_sources` で出所を記録し、義務由来は overlay で外せない      | P0     |
| TC-05 | A    | `mission_controller team` の出力を名簿 / 稼働 / 待機 / 欠員の 4 区分で表示                            | P1     |
| TC-06 | C    | ガバナンス付き再編成 `restaff`(lifecycle 上限内での役割追加、SoD 再検証、台帳追記)                    | P1     |
| TC-07 | C    | タスクの `required_capabilities` を現メンバーが満たさない場合の欠落検知とエスカレーション             | P1     |
| TC-08 | D    | `WorkforceResourceRef.availability` / `cost_profile` の実データ化(lease・並行数・モデル単価)          | P2     |
| TC-09 | D    | `worker-assignment-policy` を選抜へ合流(負荷分散と scope 衝突回避)                                    | P2     |
| TC-10 | F    | agent profile の拡充と capability 語彙の解像度向上(候補 1〜2 の役割の解消)                            | P2     |
| TC-11 | F    | capability 宣言と実測の突合(宣言だけで実行できない capability の検出)                                 | P2     |
| TC-12 | E    | LLM 提案者 `proposeTeamRoster`: 裁量ロールのみ提案、policy 検証を通過した提案だけ commit(fail-closed) | P3     |
| TC-13 | E    | 提案の受理率・後追い restaff 率の計測と、提案を採用しない既定への退避                                 | P3     |
| TC-14 | 横断 | テンプレート棚卸し(12 → 義務導出で代替できるものを削減)とドキュメント正直性                           | P3     |

**Wave 1 = TC-01〜TC-05**(本 PR 範囲)。Wave 2 = TC-06〜TC-09。Wave 3 = TC-10〜TC-14。

## 4. 設計

### 4.1 TC-01/TC-02: 充当状態の分離(B)

`MissionTeamAssignment.status` を 2 値から 3 値へ拡張する。

| status     | 意味                                                   | staffing レコード | runtime spawn |
| ---------- | ------------------------------------------------------ | ----------------- | ------------- |
| `assigned` | いま稼働(staffed)                                      | 作る              | する          |
| `standby`  | 名簿に載り、候補アクターも解決済みだが未充当           | 作らない          | しない        |
| `unfilled` | プールに適合アクターが存在しない(**実在するギャップ**) | 作らない          | しない        |

要点:

- **`standby` でも候補アクターは compose 時に解決して記録する。** これにより「あとで staffing しようとしたら独立した reviewer が居なかった」という遅延失敗が起きない。候補が居なければその場で `unfilled` になり、従来どおり作成時に検出できる。昇格は純粋な状態遷移であり再選抜を伴わないため、決定論と再現性を保つ。
- 作成時に `assigned` にするのは **構造役割のみ**(既定: `owner`, `orchestrator`)。義務由来の役割も既定は `standby` で、需要が来た時点で昇格する。
- `unfilled_required_roles` の判定を `required && status !== 'assigned'` から `required && status === 'unfilled'` へ変更する(standby を欠員として数えない)。
- 昇格の唯一の入口は `ensureMissionTeamRuntime`(dispatch は既に planner が要求した役割だけを渡している)。昇格時に `team_role_staffed` を `execution-ledger.jsonl` へ追記する。

### 4.2 TC-03/TC-04: 義務導出の役割集合(A)

`knowledge/product/governance/team-composition-obligations.json` を新設する。

```jsonc
{
  "version": "1.0.0",
  "always_staffed_roles": ["owner", "orchestrator"],
  "obligations": [
    {
      "id": "independent-review",
      "when": { "risk_profile": ["review_required", "high"] },
      "require_roles": ["reviewer"],
      "reason": "レビュー必須リスクの成果物は、実装者と独立したレビュアーの受理を要する",
    },
    // ...
  ],
}
```

意味論:

- `required_roles = template.required_roles ∪ Σ(matched obligations).require_roles`
- 義務由来の役割は **組織 overlay カタログで外せない**(`mergeMissionTeamTemplate` の後に義務を適用する)。テンプレートは既定値(seed)であり、統治要件ではない。
- 各 assignment に `role_sources: ('template' | 'obligation' | 'structural')[]` を持たせ、plan に `team_governance.obligations`(適合した義務 id と理由)を記録する。**なぜこの役割が居るのかが証跡から読める**ことが本項目の受入条件である。

### 4.3 非採用とその理由

- **LLM が役割集合を自由に決める**: 職務分離(reviewer ≠ implementer)・authority の write_scope / tier_access・`required_scope_classes` の充足は現在コードで担保されている。自由組成は「reviewer の居ないチーム」を原理的に生成可能にし、ゲートの前提を壊す。再現性(同一入力 → 同一 plan)と説明可能性(`selection_reason_codes`)も失う。TC-12 で提案者としてのみ導入し、既存検証を通過したものだけを commit する。
- **テンプレートの全廃**: 義務は下限を定めるだけで、「この組織ではこの仕事にこの布陣」という選好を表現できない。テンプレートは seed として残す。

## 5. 受入条件

| ID    | 条件                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-01 | 同一ミッションの再生成で `assigned` が構造役割のみになり、`standby` の候補アクターが決定論的に一致する。staffing-assignments.json の `active` 件数が減る |
| TC-02 | dispatch が要求した役割だけが昇格し、`execution-ledger.jsonl` に `team_role_staffed` が残る。未要求の役割は最後まで staffing されない                    |
| TC-03 | risk_profile を変えると導出役割集合が変わる(テンプレートは同一のまま)                                                                                    |
| TC-04 | 組織 overlay で reviewer を落としたテンプレートでも、`review_required` では reviewer が名簿に残り `role_sources` に `obligation` が入る                  |
| TC-05 | `mission_controller team <ID>` が 名簿 / 稼働 / 待機 / 欠員 を区別して出力する                                                                           |
| 横断  | baseline ミッションの再作成で「staffing 8 → 構造役割のみ」「要求 3 役割のみ昇格」が実測される                                                            |

## 6. 実装状況

| ID    | 状態 | 備考                                                                                                                                            |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-01 | DONE | `status: 'standby'` を導入。構造役割のみ作成時に充当                                                                                            |
| TC-02 | DONE | `staffMissionTeamRoles` + `ensureMissionTeamRuntime` の役割スコープ昇格、`team_role_staffed` 台帳                                               |
| TC-03 | DONE | `team-composition-obligations.json`(5 義務)と導出器                                                                                             |
| TC-04 | DONE | 役割集合 = テンプレート ∪ 義務、`role_sources` と `team_governance.obligations`                                                                 |
| TC-05 | DONE | `mission-team-view`(名簿 / 稼働 / 待機 / 欠員 + 出所 + 義務)、`team <ID> --summary`                                                             |
| TC-06 | DONE | `restaffMissionTeamRole` + `mission_controller restaff`、`team_role_restaffed` 台帳                                                             |
| TC-07 | DONE | `diagnoseMissionTeamRoleGap`、dispatch の自動増員リトライと `blocked(capability_gap)`                                                           |
| TC-08 | DONE | `workforce-load.ts`、`workforce-capacity-policy.json`、availability / cost_profile の実データ化                                                 |
| TC-09 | DONE | `workerLoadPenalty` を唯一の負荷スコアラとして採用、`selectAgentForTeamRole` へ合流                                                             |
| TC-10 | DONE | `critique-worker` / `coordination-worker`(別プロバイダ実体)、capability 宣言整合、死んだ `preferred_agents` の掃除と `dead_selection_hint` 検査 |
| TC-11 | DONE | `staffing-coverage.ts` + CI gate `staffing-capability-coverage`                                                                                 |
| TC-12 | DONE | `proposeMissionTeamRoster`(既定 OFF、fail-closed)、dispatch 前 1 回 + `propose-roster` CLI                                                      |
| TC-13 | DONE | `summarizeRosterProposalOutcomes`(受理率 + 後追い restaff 率)、`readMissionExecutionLedger`                                                     |
| TC-14 | DONE | テンプレート到達性監査(dangling 参照は gate 失敗、未到達は報告のみ)                                                                             |
| TC-15 | DONE | `model-role-fitness`(役割別 governed プローブと機械採点)、`evaluate_model_role_fitness` CLI                                                     |
| TC-16 | DONE | 観測が沈黙している間だけ効くコールドスタート事前分布として選抜へ合流                                                                            |
| TC-17 | DONE | `backend-capability-honesty`(宣言 utility_fit と実測プローブの突合)+ CI gate                                                                    |
| TC-18 | DONE | `mission-advisory-panel`(ロスター = 助言パネル)、`mission_controller advise`                                                                    |
| TC-19 | DONE | `team-decision-support-metrics`(ミッション横断の受理率・後追い restaff 率・意見生存率)                                                          |

### 2026-09-20: Wave 1(TC-01〜TC-04)

**TC-01/TC-02 — 需要駆動の充当**

- `MissionTeamAssignment.status` を `assigned | standby | unfilled` の 3 値へ拡張(`team-role-assignment-selection.ts`)。候補アクター・authority role・delegation contract・security scope は **standby でも compose 時に解決**するため、充当ギャップは従来どおり作成時に検出される。
- 作成時に充当するのは `always_staffed_roles`(`owner`, `orchestrator`)のみ(`applyStaffingPolicy`)。
- 昇格の唯一の入口は `staffMissionTeamRoles`(`mission-team-binding.ts`)。plan と staffing bindings を書き直し、昇格ごとに `team_role_staffed` を `execution-ledger.jsonl` へ追記する。`promoteMissionTeamPlanRoles` は純関数で、記録済み候補に対する状態遷移のみを行う(再選抜しない)。
- 役割スコープ付き `ensureMissionTeamRuntime` が充当要求そのもの。**スコープ無しの ensure は名簿全体を充当しない**(ここを緩めると eager staffing に戻る)。
- 名簿の読み取り(`resolveMissionTeamReceiver`、`buildMissionTeamView`)は standby の保持者を返し続けるため、dispatch のルーティングとレビュー独立性判定は無変更。
- `unfilled_required_roles` の判定を `required && status === 'unfilled'` へ変更(standby は欠員ではない)。
- 副産物の欠陥修正: `resolveMissionTeamPlan({ forceRefresh })` が作り直しで**稼働中メンバーを standby に戻していた**。refresh は以前の staffed 役割を引き継ぐようにした。

**TC-03/TC-04 — 義務導出の役割集合**

- `knowledge/product/governance/team-composition-obligations.json`(schema 付き governed catalog)に 5 義務: `independent-review`(review_required 以上 → reviewer)、`executed-verification`(出荷系 mission_class × review_required 以上 → tester)、`cross-system-operations`(cross_system_change → operator)、`human-approval-routing`(approval_required 以上 → surface_liaison)、`decision-divergence`(decision_support → devils_advocate)。
- 役割集合 = `template.required_roles ∪ 適合義務の require_roles`。義務由来の役割はテンプレートが optional に置いていても、そもそも記載していなくても **required になる**。テンプレート順を先に並べることで職務分離(implementer の後に reviewer を選抜)の解決順を維持している。
- `role_sources`(`structural` / `obligation` / `template`)と `team_governance.obligations`(id + 理由)を plan に記録。

### 受入証跡(ミッション `MSN-TEAM-COMPOSITION-20260920`、実機)

| 観測                                  | 変更前                                                                                    | 変更後                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 作成時の staffing レコード            | 8(owner, orchestrator, planner, implementer, reviewer, tester, operator, surface_liaison) | **2**(owner, orchestrator)                                                                                  |
| `[team]` サマリ                       | `assignments=8 required=6 assigned=8 unfilled_required=0`                                 | `roster=8 required=6 staffed=2 standby=6 unfilled_required=0`                                               |
| `prewarm <ID> planner,implementer` 後 | (概念なし)                                                                                | staffed=4、`team_role_staffed` 台帳 2 件、残り 4 役割は standby のまま                                      |
| `team <ID> --refresh` 後              | 全員 assigned                                                                             | 稼働中の planner / implementer は staffed のまま、reviewer / tester / operator / surface_liaison は standby |
| `role_sources`                        | (無し)                                                                                    | reviewer / tester = `obligation,template`、owner / orchestrator = `structural,template`                     |
| approval_required 分類のミッション    | surface_liaison は optional                                                               | **required**(`role_sources: obligation,template`、`obligations: human-approval-routing`)                    |

### テスト

- `libs/core/team-composition-obligations.test.ts`(新規 9 件): 構造役割、facet の AND/OR、テンプレートが言及しない役割の導出、義務の理由、reviewer 規則が tester 規則より前に並ぶこと。
- `libs/core/mission-team-composer.test.ts`: 充当方針、standby の決定論、需要役割のみの昇格、refresh での staffing 引き継ぎ。
- `tests/mission-team-orchestrator.test.ts`: 役割スコープ ensure が充当要求であること、スコープ無し ensure が名簿を充当しないこと。
- 回帰: 10 files / 67 tests(team 系)、25 files / 242 tests(mission 系)、tests/ の mission contract 6 files / 42 tests。

### 既知の残件

- TC-05 の専用レンダラ(名簿 / 稼働 / 待機 / 欠員の表示)は未実装。

### 2026-09-20: Wave 2(TC-06〜TC-09)

**TC-06/TC-07 — ガバナンス付き再編成と、名前のついた欠落**

- `restaffMissionTeamRole`(`mission-team-binding.ts`)が唯一の増員経路。lifecycle の `max_members` で上限を取り、capability / authority / scope_class / 職務分離は初期組成と同じ検査を通す。`role_sources: ['restaff']` と `team_role_restaffed` 台帳を残す。CLI は `mission_controller restaff <ID> <TEAM_ROLE> [--capabilities] [--exclude] [--reason]`(governed verb として `assertMissionControllerContext` 配下)。
- **初期組成との意図的な差**: `selectAgentForTeamRole` は「役割を空席にするくらいなら除外アクターにフォールバックする」。これは組成時には正しいが増員時には誤り(実装者が自分の成果物をレビューできない)。増員経路では caller の除外指定と要求 capability を**ハードチェック**して、満たせなければ `no_compatible_actor` で拒否する。
- `diagnoseMissionTeamRoleGap` が欠落を分類する: `role_not_on_roster`(増員で解決可能) / `role_unfilled` / `no_capable_actor`(プールに能力が無い = 人間が閉じるべきギャップ)。task dispatch は前者を自動で増員して 1 回だけ再試行し、後者は `blocked(capability_gap)` として**不足している capability 名を添えて**停止する(従来は全て `blocked(unassigned_role)` で「役割 X にエージェントを割り当てよ」という同一文言だった)。

**TC-08/TC-09 — 容量とコストの実データ化、負荷スコアラの一本化**

- `workforce-load.ts`: 負荷は work-item ストアから導出する(in-process の agent registry は当該プロセスの runtime しか知らないが、work item は「そのアクターが実際に何を抱えているか」の永続・プロセス横断の記録)。`availability` は `{status, active_work_items, queued_work_items, active_leases, leased_scopes, observed_at}`、`cost_profile` は governed な model cost registry 由来の per-token レート。閾値とペナルティは `workforce-capacity-policy.json`。
- **負荷は最適化信号であってゲートではない**: ストアが読めなければ「負荷情報なし」であって「誰も選べない」ではない。
- `worker-assignment-policy.ts` は「書かれているが誰も呼んでいない」状態だった。削除ではなく**採用**し、`workerLoadPenalty` を負荷意味論の唯一の実装として `recommendWorkerAssignments` と `selectAgentForTeamRole` の両方が使う。ペナルティには上限があり、capability 一致を覆さない。
- 副作用として `selectAgentForTeamRole` の 8 個の位置引数を options オブジェクトへ移行した(本番 3 + テスト 3 呼び出し)。

### Wave 2 で発見・修正した欠陥(実装の流れで露出したもの)

| #   | 症状                                                                                                                                                                                               | 修正                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`max_members` が上限として機能していない**。12 テンプレート中 11 個が `max_members == 自身のロスター数`。構造上超えようがなく、正当な増員を必ず拒否する(実機で `max_members_reached` として露出) | `max(宣言値, ロスター + governed roster_headroom)` で導出。義務がテンプレート外の役割を足した場合の整合も取れる                                             |
| 2   | **refresh が増員メンバーを捨てる**。recompose はテンプレート ∪ 義務からロスターを導くため、台帳付きの増員決定が黙って消える(実機で roster 9 → 8)                                                   | `role_sources` に `restaff` を含む assignment を引き継ぎ、lifecycle 上限も合わせて広げる                                                                    |
| 3   | **コストが既定値に黙って落ちる**。provider が表示名("Gemini 3.6 Flash (Medium)")を返すため cost registry のキーに一致せず、既定レートが「そのアクターの価格」として記録される                      | `resolveCostRateModelKey` を追加し `cost_profile.rate_source` に `registry` / `registry_default` を記録。表示名 → registry id の対応付け自体は TC-10 の残件 |
| 4   | (Wave 1 で検出)refresh が稼働中メンバーを standby に戻す                                                                                                                                           | 以前 staffed だった役割を引き継ぐ                                                                                                                           |

### Wave 2 の受入証跡(実機 `MSN-TEAM-COMPOSITION-20260920`)

| 観測                               | 結果                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restaff <ID> researcher`          | `control-plane-agent` を追加(owner の `nerve-agent` とは別アクター = 職務分離が効いている)、roster 9/10、`team_role_restaffed` 台帳に provider / model / roster_size / max_members 付きで記録 |
| 同じ役割を再度 `restaff`           | `already_on_roster` で拒否                                                                                                                                                                    |
| 修正前の `restaff`                 | `max_members_reached`(欠陥 #1 の実機再現)                                                                                                                                                     |
| `team --refresh` 後                | roster 9 のまま、`researcher` は `assigned` / `role_sources: restaff` で残存(欠陥 #2 修正の確認)                                                                                              |
| staffing レコードの `availability` | `{status: available, active_work_items: 0, ..., observed_at: ...}`(定数ではなく実測)                                                                                                          |
| staffing レコードの `cost_profile` | `{provider: agy, model_id: "Gemini 3.6 Flash (Medium)", rate_source: "registry_default", unit: per_token, ...}`(既定値であることが明示される)                                                 |

### Wave 2 のテスト

- `libs/core/workforce-load.test.ts`(新規 6 件): 未知リソースは available、実測 availability、governed レート、モデル無しは空、ペナルティ上限、**同条件なら空いているアクターが選ばれる**。
- `libs/core/mission-team-composer.test.ts`: 増員の成功 / 職務分離 / 4 種の拒否理由 / 上限ヘッドルーム / refresh での増員メンバー残存、gap 診断 3 件。
- `libs/core/mission-lifecycle-service.test.ts`: `restaff` を governed verb ゲート表に追加。

### 2026-09-20: Wave 3(TC-10〜TC-14)

**TC-11 — 「宣言」と「プール」の突合(最も大きな発見)**

team role は `required_capabilities` を、agent profile は `capabilities` を宣言していたが、**両者は一度も突き合わされていなかった**。選抜は能力不足をスコアのペナルティとして扱うだけで拒否しないため、**誰も満たせない役割も「最もマシな候補」で黙って充当される**。実測:

- 19 役割中 **5 役割で「完全に能力を満たす候補が 0」**(`product_strategist`, `relationship_curator`, `scribe`, `tester`, `tracker`)
- **6 個の capability がどの agent にも宣言されていない**(`curation`, `memory_management`, `privacy`, `product`, `quality`, `tracking`)
- うち `tester` は `executed-verification` 義務が必須にする役割 = 出荷変更のたびに要求されるのに、能力を満たす候補がいなかった

`libs/core/staffing-coverage.ts` がこれをデータ化し、CI gate `staffing-capability-coverage`(`ci-gates.json` に登録)が**システムが実際に要求する役割についてのみ失敗**する: ①義務が要求しうる役割に完全充足候補が無い、②テンプレートが required 宣言する役割に候補が 0、③ハード職務分離ペアがプール上そもそも独立になり得ない。残りの薄い役割は表に出し続ける(閉じるにはエージェント追加か宣言取り下げが必要で、これは運用判断であり、ここで能力を捏造すべきではない)。

**TC-10 — 閉じられるギャップだけ閉じる**

- `quality` を `implementation-architect` / `reasoning-worker` に追加(両者とも既に `testing` と `review` を宣言しており、主張として正当)。これで gate の唯一の違反が解消。
- **コスト解決の欠陥修正**: provider は表示名("Gemini 3.6 Flash (Medium)")を返すため registry キーに一致せず、既定レートが黙って「そのアクターの価格」になっていた。英数字スケルトン比較に変更(長い候補優先は維持するので `gpt-4o-mini` が `gpt-4o` に負けない)。
- **プールの薄さ自体は未解決のまま報告**: `orchestrator` 1、`devils_advocate` 1、`counterparty_persona` 1。エージェントの新設は実ランタイムの裏付けが要るため、ここでは行わない。

**TC-14 — テンプレート到達性**

未知のテンプレートは失敗せず既定チームへフォールバックするため、intent ontology や組織カタログの綴り誤りは「黙って別の布陣を出す」。dangling 参照を gate 失敗にした。自動経路が到達しないテンプレートは**報告のみ**(明示 `--mission-type` で選べるため)。現状の唯一の該当は `meeting_facilitation`。職務分離ペアは `SEPARATION_ROLE_PAIRS` として 1 箇所に宣言し、選抜と coverage 検査が同じ表を読む。

**TC-12/TC-13 — 決定できない提案者**

`proposeMissionTeamRoster` は ADF と同じ形(`draft → preflight → commit`):

- governed な team-role index の中からしか役割を挙げられない。**捏造ロールは落とし、解析不能な応答は「提案なし」**として扱う(推測しない)。
- 通過した提案は `restaffMissionTeamRole` 経由で commit されるため、capability / authority / scope_class / 職務分離 / `max_members` が人間の restaff と完全に同じに適用される。
- **既定 OFF**。導出ロスターが製品の挙動であり、提案者はそれに勝たなければならない opt-in。
- TC-13 は自己申告ではなく台帳から測る。受理率だけでは「安全な提案しかしない提案者」を過大評価するため、**`follow_up_restaff_rate`(提案器の実行後に他者が追加せざるを得なかった役割の比率)**を併せて出す。`readMissionExecutionLedger` で、書き手しかいなかった台帳をようやく読む。
- 呼び出し元が無ければ Wave 2 で批判した「書かれているが誰も呼ばない」状態そのものになるため、**dispatch の初回波の前に 1 回(policy gated / best-effort / dispatch を失敗させない)** と **`mission_controller propose-roster <ID> [--context] [--force]`** の両端に配線した。

### Wave 3 の受入証跡(実機)

| 観測                                                          | 結果                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `check_staffing_capability_coverage`(修正前)                  | `[obligation_role_uncovered] tester: missing quality` で失敗                                                            |
| 同(修正後)                                                    | violations なし。薄い役割とテンプレート経路は表として出力                                                               |
| 提案器 @ `MSN-TEAM-COMPOSITION-20260920`(充足済みチーム)      | **提案 0 件**(「不要なメンバーは予算と注意のコスト」というプロンプト方針どおり)                                         |
| 提案器 @ `MSN-TC-PROPOSER-PROBE-20260920`(交渉リハーサル文脈) | `counterparty_persona` と `devils_advocate` を提案 → **2/2 受理**、`role_sources: restaff`、台帳に rationale 付きで記録 |
| 同ミッションで追加提案(議事録係が欲しい文脈)                  | `scribe` / `tracker` を提案 → **2/2 が `max_members_reached` で拒否**(roster 10/10、上限が実機で効くことの確認)         |
| `mission_controller propose-roster`(既定)                     | `status=disabled` を返しつつ、過去の受理率 0.50 / 後追い restaff 率 0.00 を表示                                         |

いずれの受理も `reasoning-worker` に解決された(該当役割の候補が 1 名しかいないため)。TC-10 のプール厚み課題が実運用で現れた形である。

### 2026-09-20: Wave 4(TC-15〜TC-19)— 新規モデルの役割適性と、チーム内助言

起点: 「LLM プロバイダ・モデルは今後も大量に増える。実際に役割たりえるかを各モデルで評価する機構は作れるか」「アドバイザーなどエージェント間の会話の仕組みを組み込みたい」。

**棚卸しの結論: どちらも土台はあり、欠けているのはチーム層との接続だった。**

**TC-15/TC-16 — モデル×役割の適性評価**

「このモデルはこの役割をこなせるか」への答えが 3 箇所にあり、どれも答えていなかった:

| 既存                          | 実際に答えていること                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BACKEND_CAPABILITY_PROFILES` | 手書き宣言。バックエンド**モード**単位で、モデル単位でも役割単位でもない                                           |
| provider capability scanner   | CLI が起動するかの探査。コードレビューができるかではない                                                           |
| `model-performance-index`     | 純粋に観測ベース。実ミッションで先に任せないと役割スコアが付かない(`MODEL_PERFORMANCE_MIN_SAMPLES` 未満は調整値 0) |

新しいプロバイダ・モデルが継続的に増える以上、この**コールドスタートは例外ではなく常態**である。`model-role-fitness.ts` は役割ごとの governed プローブ(`model-role-fitness-probes.json`)を**機械的に採点**する。モデルに他モデルを評価させない — 審査員は測ろうとしている弱点をそのまま受け継ぐため。

- **設計修正(実装中に発見)**: 構造的 assertion が多数派のため、**形式を満たし埋め込んだ欠陥を見逃した回答が 0.75 で合格**していた。契約遵守(採点対象)と正答(`required`)を分離し、required が落ちれば点数に関係なく不合格とした。
- **記録の正直性**: `options.model` は要求であって保証ではなく、「実際にどのモデルが答えたか」を返すバックエンド API が無い。誤ラベルの証跡は実際の人員配置を動かすため、**要求モデルのプロバイダと稼働バックエンドのプロバイダが異なる場合は記録を拒否**する。
- TC-16 は**観測が沈黙している間だけ**選抜に効く。プローブは「契約を守れる」証明であって「良い仕事をする」証明ではない。

**TC-18 — ミッションが自分のチームに諮る**

perspective fanout / typed cross critique / dissent log は既にあったが、**全て手書きの participant を取る**ため、助言会話はパイプライン作者が考えたラベル同士で行われていた。一方チーム組成は全ロスターメンバーの `participant_id` / `perspective_ids` / `reasoning_route_id` / `security_scope` を既に解決しており、それを plan ファイル以外に一切使っていなかった。

`mission-advisory-panel.ts` はその欠けていた射影である: **ロスターがそのままパネル**。各メンバーが自分の役割と視点から答え、パネルが自分たちの意見を相互批判し、**ミッションの tier を読めない助言者は拒否される**(typed cross-critique と同じ規則)。

**配線**: Wave 2 で「書かれているが誰も呼ばない」を指摘した以上、両機構とも入口を持つ — `evaluate_model_role_fitness`(書込スコープが fitness ジャーナルのみの専用 authority role)と `mission_controller advise`。適性スコアの読取経路が LLM スタックを引き込まないよう、プローブ実行器は採点モジュールから分離した。

### Wave 4 の受入証跡(実機)

| 観測                                                                  | 結果                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate_model_role_fitness --model claude-opus-5 --provider claude` | reviewer / planner / tester / implementer **4 役割すべて PASS**(score 1.00)                                                                                                                                |
| 同 `--model gemini-3.8-flash` を claude バックエンド下で              | **記録を拒否**(「答えていないモデル名で証跡を残さない」)                                                                                                                                                   |
| 欠陥入りコードで line を外した整形済み回答                            | score 0.75 でも `required` 不成立により**不合格**(修正前は合格していた)                                                                                                                                    |
| `mission_controller advise`(4 名パネル、交渉判断)                     | `value_maximizer` / `rigorous_validator` / `counterparty_modeler` / `ruthless_auditor` の**ロスター由来の視点**で相異なる意見。パネル自身の批判が **2/4 を理由付きで棄却**し、全て execution ledger に記録 |

### Wave 4 で発見・修正した欠陥

| #   | 症状                                                                                                                                                                                                                  | 修正                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 5   | `mission-runtime`(ミッション CLI の薄い補助層)が提案器経由で**推論バックエンドのグラフ全体を静的に取り込み**、2 suite の module 初期化を壊していた。毎回の `mission_controller` 実行で LLM スタックを読むことにもなる | 使用時 import へ変更。適性評価も同じ理由で実行器を分離                                    |
| 6   | 構造的 assertion の多数決で「形式は満たすが判断を外した回答」が合格                                                                                                                                                   | 正答 assertion を `required` に分離                                                       |
| 7   | **authority role の登録が 3 箇所**(正本ディレクトリ / `security-policy` の書込ゲート / index スナップショット)。index だけ書くとスナップショットが正本より先行し契約テストが落ちる                                    | 正本を追加し governed generator で整合(既存 8 ファイルの差分は整形のみ、パース比較で確認) |

### 2026-09-21: Wave 5(TC-05 / TC-17 / TC-19)と Codex Luna レビューの取り込み

Codex Luna が Waves 1〜4 をレビューしている間、別ワークツリー(`kyberion-tc-wave5` / `agent/team-composition-wave5-20260921`)で Wave 5 を進めた。Codex は `kyberion-team-comp` 内で直接作業していたため、multi-provider co-execution contract(write = claim holder のみ)に従い、そのワークツリーには読み取り以外行っていない。

**TC-17 — 宣言された能力と実測の突合**

`BACKEND_CAPABILITY_PROFILES` の `utility_fit` は「このバックエンドは judge できる」= モデルをレビュアーとして信用してよいかを決める、この表で最も強い主張である。そしてその値は**デフォルト引数で生成**されていた — 手で上書きしない限り全 CLI/API バックエンドが `judge, classify, summarize, divergent` を名乗る。TC-15 以前はそもそも突き合わせる実測が存在しなかった。

TC-11 と同型: 実測に**矛盾**する主張は gate 失敗、**証拠なし**は報告に留める(unproven は見るべき事実であってブロックすべき欠陥ではない)。プローブの無い classify / summarize / divergent は代理指標を当てず `unmeasurable` と名指しする。副産物として `nemotron` が governed policy の許可モードに無い宣言プロファイル(死んだ宣言)であることも検出した(報告のみ)。

**TC-19 — 決定支援機構のミッション横断計測**

提案器(TC-12)と助言パネル(TC-18)はどちらも「無くても動いていた経路に推論呼び出しを足す」機能である。継続可否を決めるのは「このミッションで何が起きたか」ではなく「元が取れているか」で、per-mission 要約では答えられない。**都合の悪い指標を先頭に置く**: `follow_up_restaff_rate`(提案器の実行後に他者が追加せざるを得なかった役割 — 安全で自明な提案しかしない提案器が隠れられない)と `opinion_survival_rate`(全部生き残るパネルは議論しておらず、全部落ちるパネルは助言していない)。すべて台帳の記録から読み、両機能の自己申告は使わない。

**TC-05 — 4 区分のレンダラ**

`team <ID> --summary` が、ロスター対 lifecycle 上限、役割ごとの状態と出所(structural / obligation / template / restaff)、ロスターを形作った義務とその理由、そして「本当に人間が要る状態か」を出す。JSON は既定のまま(既存の消費者を壊さない)。

### Codex Luna レビューの指摘(4 件すべて実バグ)

| #   | 症状                                                                                                                                                                                                                                                                        | 影響                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **構造役割をテンプレート依存として扱っていた**。owner / orchestrator が `required_roles` に必ずあるという前提。組織 overlay がその配列を差し替えると、ロスターに両者が無く、`applyStaffingPolicy` は構造役割だけを充当するため**誰も staffed されないミッション**が生まれる | 重大。ガバナンス不変条件と組織選好の混同                          |
| 2   | **TC-02 の配線がタスク dispatch 1 経路だけだった**。ticket dispatch / work-item dispatch / surface delegation も役割で受け手を解決して仕事を流すが、TC-01 以降それらの役割は standby。**staffing レコードも runtime も台帳記録も無いアクターに仕事が渡る**                  | 重大。「dispatch」を 1 ファイルと思い込み、他の入口を探さなかった |
| 3   | chronos plan-preview クライアントが独自の狭いパーサを持ち `standby` を拒否。standby を含む plan は UI でパース失敗                                                                                                                                                          | スキーマを広げて消費者を探さなかった                              |
| 4   | `agent-profile-index.json`(正本ディレクトリの fallback スナップショット)が TC-10 の `quality` 追加に追随せずドリフト                                                                                                                                                        | `check_governance_rules` が検出する違反                           |

**#4 はプロセスの穴を突いている**: 毎 Wave で core スイート(最大 955 files / 7,689 tests)を回しながら、**PR ゲート一式を一度も回していなかった**。取り込み前の `check_governance_rules` は実際に 2 件の違反を報告していた。

### PR ゲート(初回実行)

37 ゲート中 35 PASS / 2 FAILED。新規 2 ゲート(`staffing-capability-coverage`、`backend-capability-honesty`)はいずれも PASS。

- `type-ratchet` FAILED — テストのスタブで `as any` を 3 箇所増やしていた。SX の教訓(「checker を緑に調整する方向の修正」は批判対象)に従い**ラチェットは据え置き、型を直した**(3 つとも正当に `undefined` を返す verb でキャスト不要)。
- `golden` FAILED — 当該ワークツリーで `build:actuators` 未実行だったための環境不足。コード欠陥ではない。

修正後の再実行: **37/37 PASS(failed=0)**。

### 2026-09-21: TC-10 プールの厚み(Codex Luna 第二次レビュー反映後)

Wave 3 では「エージェント新設は実ランタイムの裏付けを要する運用判断」として報告に留めていた項目。計測すると、薄さは頭数の問題ではなく **2 つの構造問題**だった。

1. **`reasoning-worker` 1 体が 12 役割の唯一 / ほぼ唯一の候補**。職務分離は「同一アクター + ソフトペナルティ」に劣化し、`SOD_AVOID_AGENT_PENALTY` のフォールバックが常時発火する状態。
2. **全エージェントが `agy` を preferred provider にしていた**。Wave 1 で書いた「別のモデル系統がレビューする」規則(`avoidProviders`)は、宣言レベルで**満たしようがなく装飾だった**。

**追加した 2 体**(manifest + profile の両方。manifest は実行時プロンプトと actuator 許可を持つ実体):

| agent                 | provider | 役割                                                              | 設計意図                                                                                                                       |
| --------------------- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `critique-worker`     | claude   | reviewer, tester, devils_advocate, counterparty_persona, defender | **実装を担当しない**。レビュー対象から構造的に独立させる。claude-opus-5 は TC-15 の reviewer / tester プローブを実測で通過済み |
| `coordination-worker` | gemini   | scribe, tracker, facilitator                                      | 記録・追跡・進行。`listening` / `tracking` / `documentation` の欠落を実体で埋める                                              |

**`preferred_agents` の 40% が死んでいた**: 43 件中 17 件が、その役割を持てないエージェント名だった(`counterparty_persona` / `devils_advocate` / `relationship_curator` は選好が丸ごと無効)。死んだ選好は誰にもボーナスを与えず、選抜を黙って汎用スコアに委ねる。掃除したうえで `dead_selection_hint` 検査を追加し、差し戻して検出されることを確認した。

| 指標                                    | 前    | 後                                                                 |
| --------------------------------------- | ----- | ------------------------------------------------------------------ |
| 能力を満たす候補が 0 の役割             | 5     | **1**(`relationship_curator`、どのテンプレート / 義務も要求しない) |
| どのエージェントも宣言しない capability | 6     | **3**                                                              |
| `devils_advocate`(義務必須)の充足候補   | 1     | **2**                                                              |
| 死んだ `preferred_agents`               | 17/43 | **0**                                                              |

**検査の強化**: 職務分離の独立性判定を「候補集合」から「**能力を満たす候補集合**」へ変更した(その役割を実際にこなせないアクターは独立性の担保にならない)。あわせて各役割の provider 系統と、ハード分離ペアが**別系統で成立可能か**を報告する。

実機の組成: `development` テンプレートで implementer = `reasoning-worker`(agy)、reviewer = `critique-worker`(claude)。**別アクターかつ別モデル系統でのレビューが初めて成立**した。

### 三度目の「正本 + スナップショット」

正本ディレクトリとスナップショットの二重構造は **3 カタログ**(authority-roles / agent-profiles / team-roles)に存在し、**生成器があるのは 1 つだけ**だった。本作業でも snapshot 側を編集して空振りしている(Codex が直した TC-10 ドリフトと同じ原因)。`sync_agent_profiles.ts` を追加してこのクラスを塞いだ。team-roles には既存の `sync_team_roles.ts` がある。

### 2026-09-21: `relationship_curator` の実体化と、egress 判定基準の作り直し

**TC-10 の残件だった `relationship_curator`** に専用エージェントを作った(manifest + profile)。この役割は機密の関係グラフ(trust_level / history / outstanding_asks / ng_topics)を扱うため、manifest には「人が自分について読み返す日が来るかもしれない記録として扱う」「人格や動機を推論して保存しない」「NG トピックは境界としてのみ記録し、背景の出来事を再構成しない」を規律として置き、actuator は knowledge_steward と整合する wisdom / artifact のみ(network・browser・code・system・deployment は拒否)。

authority は `knowledge_steward`(`knowledge/` のみ書ける最小権限)。`ecosystem_architect` も scope class は満たすが libs/core・scripts・pipelines への書き込み権を持ち、関係グラフの管理には過大である。これに伴い役割の `compatible_authority_roles` から死んだ `mission_controller`(要求 scope class `knowledge_core` を持たない = 一度も選択され得なかった)を外した。同種の死んだ宣言は **48 件中 6 件**あり、まとめて掃除した。

`control-plane-agent` からは `relationship_curator` の宣言を削除した。3 つの required capability をどれも宣言しておらず、`team_roles` と `capabilities` が矛盾していた。

**`coordination-worker` の provider 誤り**: TC-10 で作ったこのエージェントを `gemini` に固定していたが、`provider-config.json` は `gemini` を `obsolete_agent_runtime_providers` に宣言済みだった(Gemini ACP is obsolete for personal OAuth environments)。「preferred が gemini なのに claude へ解決される」現象を観測しながらルーティング層の裁量と解釈して追わなかったのが誤り。`codex` へ振り直し、**`obsolete_preferred_provider` 検査**を追加して同種を検出できるようにした(差し戻して検出を確認済み)。

### egress: 「承認リスト」から「学習に使われるか」へ

`provider-egress-policy.json` の `approved_providers: ["claude"]` には**根拠が無かった**。導入コミット(`2e1166a3d`, XP-03, 2026-07-25)のメッセージ自身が "default claude only" と書いており、docs にも根拠の記述は無い。未検討の既定値である。

本来の基準は**外部送信された材料がモデルの学習に使われるか**であり、それは provider の属性ではなく**購入したプランの属性**である(同じ API でも無料と有料で異なる)。作り直した形:

| 置き場所                                          | 内容                                                                                                      | 理由                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `provider-egress-policy.json`(公開・コミット対象) | `training_use` の語彙と `attestation_ttl_days`。**全 provider は `unknown`**                              | このファイルは MIT で公開される。誰の契約も代弁できない                          |
| tenant profile(`knowledge/personal/`、git 管理外) | `provider_attestations`: `training_use` / `plan` / `basis` / `attested_by` / `attested_at` / `expires_at` | 契約は一人の運用者の口座についての事実であり、プロジェクトについての事実ではない |

- `unknown` はゲート上 `used` と同じ扱い(未宣言は fail-closed)
- **失効する**: プランは誰もリポジトリに触れないままダウングレードされ得るので、再確認されない主張は既定 180 日で `unknown` に戻る。日付が解釈できない主張も expired 扱い
- 判定順: local-only → テナントの有効な宣言 → グローバル既定 → 明示の運用例外 → 拒否
- `approved_providers` は残したが**「監査される運用例外」へ格下げ**し、出荷値は空にした。素の clone は attest するまで confidential / personal が全拒否になる
- `pnpm tenant attest-provider` を追加(記名・プラン・根拠・失効つきの記録経路)

**personal の要求水準を下げた**: 「外に出さない」ではなく confidential と同じ「学習されない」を基準にした。personal の作業にも模型を要する実用(旅行調査など)があり、それを禁じる規則は迂回されるだけである。

**ゲートが tenant profile を自分のポリシー入力として読むようにした**: tenant profile は personal 階層にあり通常の worker ペルソナでは読めないため、テナント付きの呼び出しは**常にテナント解決に失敗して拒否**されていた。安全側ではあるが `allowed_reasoning_backends` も attestation も一度も参照されない = 両方が不活性だった(本変更以前からの性質)。昇格は同期の 1 回の読み取りに限定し、personal の **read はあるが write は無い** `ecosystem_architect` を使い、プロファイルは呼び出し元に返さない。

### 同一ミリ秒の台帳エントリを取りこぼしていた(TC-13 / TC-19 の欠陥)

`follow_up_restaff_rate` の算定が「最後の提案実行より後」を **ISO タイムスタンプ比較**で判定していた。台帳に同一ミリ秒で追記された増員は `ts` が同値になり、`>` が偽になって取りこぼされる。提案直後の増員はまさに同一ミリ秒になりやすく、実運用で効く欠陥である。台帳は append-only なので**追記順(位置)**で判定するよう両集計を修正した。並列実行の揺らぎがこれを顕在化させた。
