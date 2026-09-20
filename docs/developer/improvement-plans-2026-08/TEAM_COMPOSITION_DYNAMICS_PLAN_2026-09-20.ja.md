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

**「テンプレート固定 vs LLM 自由組成」は正しい対立軸ではない。** 現状はすでに半分プール選抜であり、本当に固定なのは *役割集合* と *充当タイミング* の 2 点である。したがって本計画は次の形を採る。

> **制約(envelope)は宣言的に導出し、充当(staffing)は需要駆動にする。LLM は提案者に限定し、既存の policy / authority / SoD 検証を通過したものだけを commit する。**

これは本リポジトリが ADF(`draft → preflight → auto-repair → commit → execute`)と creative brief(semantic brief + design cascade)で既に採っている形と同一であり、新しい統治概念を持ち込まない。

## 1. 現状監査(2026-09-20 実測)

### 1.1 どこが静的で、どこが既に動的か

| 層 | 実体 | 静/動 |
| --- | --- | --- |
| ミッション分類 | `resolveMissionClassification`(`mission_class` / `delivery_shape` / `risk_profile` / `stage`) | 動 |
| **役割集合** | `knowledge/product/orchestration/mission-team-templates.json`(12 テンプレート) | **静** |
| 役割 → アクター | `libs/core/team-role-assignment-selection.ts` `selectAgentForTeamRole` | 動 |
| **充当タイミング** | `composeMissionTeamPlan` が mission 作成時に全役割を一括確定 | **静** |
| 実体化(spawn) | `mission-team-orchestrator.ts` `ensureMissionTeamRuntime`(`teamRoles` フィルタ可) | 半動 |
| タスク → 担当 | planner が `assigned_to.role` を出し、dispatch が必要ロールのみ prewarm | 動 |

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

| ID | 区分 | 内容 | 優先度 |
| --- | --- | --- | --- |
| TC-01 | B | 充当状態 `standby` の導入。plan は名簿 + 封筒、staffing は staffed のみ | P0 |
| TC-02 | B | 需要駆動の昇格(standby → assigned)を `ensureMissionTeamRuntime` に接続し、執行台帳へ記録 | P0 |
| TC-03 | A | 義務ポリシーカタログ `team-composition-obligations.json` と導出器 | P0 |
| TC-04 | A | 役割集合 = テンプレート ∪ 義務導出。`role_sources` で出所を記録し、義務由来は overlay で外せない | P0 |
| TC-05 | A | `mission_controller team` の出力を名簿 / 稼働 / 待機 / 欠員の 4 区分で表示 | P1 |
| TC-06 | C | ガバナンス付き再編成 `restaff`(lifecycle 上限内での役割追加、SoD 再検証、台帳追記) | P1 |
| TC-07 | C | タスクの `required_capabilities` を現メンバーが満たさない場合の欠落検知とエスカレーション | P1 |
| TC-08 | D | `WorkforceResourceRef.availability` / `cost_profile` の実データ化(lease・並行数・モデル単価) | P2 |
| TC-09 | D | `worker-assignment-policy` を選抜へ合流(負荷分散と scope 衝突回避) | P2 |
| TC-10 | F | agent profile の拡充と capability 語彙の解像度向上(候補 1〜2 の役割の解消) | P2 |
| TC-11 | F | capability 宣言と実測の突合(宣言だけで実行できない capability の検出) | P2 |
| TC-12 | E | LLM 提案者 `proposeTeamRoster`: 裁量ロールのみ提案、policy 検証を通過した提案だけ commit(fail-closed) | P3 |
| TC-13 | E | 提案の受理率・後追い restaff 率の計測と、提案を採用しない既定への退避 | P3 |
| TC-14 | 横断 | テンプレート棚卸し(12 → 義務導出で代替できるものを削減)とドキュメント正直性 | P3 |

**Wave 1 = TC-01〜TC-05**(本 PR 範囲)。Wave 2 = TC-06〜TC-09。Wave 3 = TC-10〜TC-14。

## 4. 設計

### 4.1 TC-01/TC-02: 充当状態の分離(B)

`MissionTeamAssignment.status` を 2 値から 3 値へ拡張する。

| status | 意味 | staffing レコード | runtime spawn |
| --- | --- | --- | --- |
| `assigned` | いま稼働(staffed) | 作る | する |
| `standby` | 名簿に載り、候補アクターも解決済みだが未充当 | 作らない | しない |
| `unfilled` | プールに適合アクターが存在しない(**実在するギャップ**) | 作らない | しない |

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
      "reason": "レビュー必須リスクの成果物は、実装者と独立したレビュアーの受理を要する"
    }
    // ...
  ]
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

| ID | 条件 |
| --- | --- |
| TC-01 | 同一ミッションの再生成で `assigned` が構造役割のみになり、`standby` の候補アクターが決定論的に一致する。staffing-assignments.json の `active` 件数が減る |
| TC-02 | dispatch が要求した役割だけが昇格し、`execution-ledger.jsonl` に `team_role_staffed` が残る。未要求の役割は最後まで staffing されない |
| TC-03 | risk_profile を変えると導出役割集合が変わる(テンプレートは同一のまま) |
| TC-04 | 組織 overlay で reviewer を落としたテンプレートでも、`review_required` では reviewer が名簿に残り `role_sources` に `obligation` が入る |
| TC-05 | `mission_controller team <ID>` が 名簿 / 稼働 / 待機 / 欠員 を区別して出力する |
| 横断 | baseline ミッションの再作成で「staffing 8 → 構造役割のみ」「要求 3 役割のみ昇格」が実測される |

## 6. 実装状況

(実装に伴い追記する)

