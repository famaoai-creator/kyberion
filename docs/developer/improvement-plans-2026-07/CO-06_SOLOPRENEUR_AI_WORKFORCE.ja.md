# ソロプレナー AI Workforce Operating Model

> **ID**: CO-06  
> **優先度**: P0  
> **規模**: L（6タスク、段階導入）  
> **依存**: CO-01、CO-04、MO-03、MO-06、OP-01、SU-01〜04、SA-05  
> **位置づけ**: ソロプレナーを唯一の最終責任者とし、人間とAIエージェントを同一の労働リソースとして編成するための横断計画

> **実装状況 (2026-07-12)**: W0〜W5を実装済み。actor-neutral resource、legacy staffing正規化、human accountable owner、human-only approval、approval payload/effect binding、decision-rights human-final semantics、resource usage ledger、Company Home workforce projection、human acceptance/delivery receipt、主要承認surfaceのmetadata接続、delivery receiptを前提にしたmemory promotion guardまで完了。

## 1. 結論

既存の `Organization Work Loop` と `Enterprise Operating Kernel` は、この運営モデルにも利用できる。ただし、次の2つを分離しなければならない。

- **workforce parity**: 人間とAIは、能力、空き状況、コスト、作業リース、成果物という共通契約で仕事を割り当てられる。
- **accountability asymmetry**: 法的責任、最終承認、損失受容、例外判断、事業停止判断は、常に人間の accountable owner に帰属する。

したがって「人間とAIを同じ労働リソースとして扱う」は妥当だが、「人間とAIが同じ権限・責任を持つ」と解釈してはならない。AIは `responsible worker` になれるが、最終的な `accountable owner` にはなれない。

## 2. 目標運営モデル

```text
Solo Founder / Accountable Owner
  ├─ defines intent, risk appetite, budget and decision rights
  ├─ approves reserved decisions and accepts outcomes
  └─ can pause, revoke or stop every delegated execution

AI Workforce
  ├─ receives bounded work leases
  ├─ plans, executes, reviews and produces evidence
  ├─ may supervise or review other AI workers
  └─ must escalate reserved decisions and boundary violations
```

### 2.1 同一に扱うもの

| 項目                    | 人間               | AI                          |
| ----------------------- | ------------------ | --------------------------- |
| actor ID                | 必須               | 必須                        |
| role / capability       | 宣言する           | manifest・probeから解決する |
| assignment / work lease | 利用可能           | 利用可能                    |
| status / availability   | 記録する           | runtimeから記録する         |
| work cost               | 人件時間・外注費   | token・API・compute・SaaS費 |
| output / evidence       | 成果物と判断記録   | artifact・trace・receipt    |
| performance             | 品質・期限・再作業 | 品質・期限・失敗・再作業    |

### 2.2 人間だけが持つもの

- `accountable_owner_id`
- 会社を法的・財務的に拘束する最終決定
- risk appetite と損失上限の設定
- 外部送信、契約締結、支払、採用・解雇、資格情報変更の予約決定
- AIへの委任権限の発行・更新・取消
- incident時のbreak-glass判断と事業継続判断
- 最終成果の受領、却下、修正要求

AIによるレビュー、critic、judge、品質ゲートは利用できるが、人間承認が必要な操作についてAIレビューを最終承認に代用してはならない。

## 3. 現状とギャップ

### 再利用できる基盤

- `organization-profile` はmission/team/modelの既定を持つが、workforce actorとaccountable ownerを表現していない。
- `decision-rights` は決定種別、role、threshold、review、escalationを持つ。
- `work-coordination` はwork itemとlease、holder、期限、競合を管理する。
- `spend-guard` はLLM費用の日次・mission上限を実行前に評価できる。
- CEO surface はIntent、Approval、Outcome、Exceptionの4フィードを既に集約する。
- mission trace、audit、artifact、approval、kill switchは責任境界を実装する土台になる。

### 足りない契約

1. `MissionActorType = agent | human | service` は存在するが、team/task生成が `agent_id` 固定で、共通resource contractとして完結していない。
2. mission/work itemに `responsible_actor_id` と `accountable_owner_id` の分離がない。
3. 委任が capability、データtier、外部副作用、予算、期限を束縛したleaseになっていない。
4. AIからAIへの再委任で権限が増えないことを保証するattenuation ruleがない。
5. human-reserved decisionを全actuatorの共通実行境界で強制していない。
6. LLM費用以外のAPI、広告、購入、外注、クラウド費用を同じ予算台帳で扱えない。
7. CEO surfaceがactor別の稼働、費用、品質、例外、承認理由を示さない。
8. 完了判定が成果物の生成と、人間による受領・責任引受を分離していない。

## 4. 不変条件

1. すべてのactive organizationは、1人以上のhuman `accountable_owner` を持つ。
2. AI actorは `accountable_owner` になれない。
3. すべてのmissionとexternal-effect work itemは `accountable_owner_id` を持つ。
4. AIは有効なdelegation leaseの範囲内でのみ実行する。
5. 再委任は元leaseより capability、tier、予算、期限、riskのいずれも拡大できない。
6. 契約締結、送金・購入、秘密・権限変更、対外公表、採用・解雇、法定申告はhuman-reserved decisionとする。
7. AIの賛成票、critic結果、judge scoreをhuman approvalとして記録しない。
8. 予算超過、scope不一致、低信頼、証拠不足、期限切れ、policy不明は停止または人間へescalateする。
9. 人間は全leaseを即時取消でき、kill switchは子・孫委任にも伝播する。
10. `completed` は実行完了、`accepted` は人間の成果受領として別状態にする。

## 5. 実装タスク

### Task 1: Actor-neutral Workforce Resource Contract

**担当**: `claude-sonnet-4`  
**対象**:

- `knowledge/product/schemas/workforce-resource-ref.schema.json`（新規）
- `knowledge/product/governance/organization-profile.json`
- `knowledge/product/schemas/organization-profile.schema.json`
- `libs/core/mission-team-binding.ts`
- `knowledge/product/schemas/mission-team-plan.schema.json`
- `knowledge/product/schemas/task-contract.schema.json`

既存の `MissionStaffingAssignment` を正本へ昇格し、`agent_id` 固定のteam/task生成をactor-neutralにする。共通resource参照:

- `resource_id`
- `resource_type: human | agent | service`
- `display_name`
- `authority_roles`
- `capabilities`
- `availability`
- `cost_profile`
- `status: active | suspended | revoked`
- `accountable_human_id`（agent/serviceでは必須）
- agentの場合は `provider`、`model_id`、`runtime_identity`

`agent_id`、`owner_agent_id`、`worker_agent_id` は読み取り互換aliasとして移行期間だけ残し、生成時はresource形式へ正規化する。resource masterはtenant/customerのconfidential overlayに置き、product tierへ個人情報を保存しない。

**受入条件**:

- 1 mission内でhuman owner、AI planner/implementer、serviceを同じstaffing schemaで表現できる。
- human taskはreasoning backendへ送らず `awaiting_human` として同じinboxへ送る。
- agent/serviceに `accountable_human_id` がなければ拒否する。
- suspended/revoked resourceを新規work itemへ割り当てられない。
- legacy agent-only fixtureをmigrationなしで読み、resource形式へ正規化できる。

### Task 2: Accountable Mission and Delegation Lease

**担当**: `claude-sonnet-4`  
**対象**:

- mission/task/work-item関連schema
- `libs/core/work-coordination.ts`
- mission team binding / orchestration worker
- trace / audit correlation

追加項目:

- `responsible_actor_id`
- `accountable_owner_id`
- `delegated_by_actor_id`
- `delegation_lease_id`
- `allowed_capabilities`
- `allowed_tiers`
- `allowed_effects`
- `max_cost`
- `expires_at`
- `escalation_policy`

**受入条件**:

- accountable owner不在のexternal-effect taskをpreflightで拒否する。
- 子leaseが親leaseより権限・予算・期限を拡張すると拒否する。
- lease expiry/revocation後の実行を拒否し、reasonとownerをtraceに残す。
- kill switchが全descendant leaseを停止する。

### Task 3: Human-Reserved Decision Enforcement

**担当**: `claude-opus` が境界設計、`claude-sonnet-4` が実装  
**対象**:

- `knowledge/product/governance/decision-rights.json`
- `knowledge/product/schemas/decision-rights.schema.json`
- `knowledge/product/governance/approval-policy.json`
- approval / risky-op / actuator dispatchの共通境界

decision rightに次を追加する。

- `accountability: human_required | human_on_exception | delegated`
- `reserved_action_kind`
- `approval_freshness`
- `evidence_requirements`
- `max_delegable_threshold`
- `break_glass_policy`
- `final_decision_holder: human`

初期のhuman-reserved set:

- contract binding / signature
- payment / purchase / bank detail change
- credential / authority / policy mutation
- external publication / customer commitment
- hiring / termination / compensation change
- tax / statutory filing
- destructive data deletion / legal hold release

**受入条件**:

- actor kindに関係なく、全actuator mutationが同じpolicy enforcement pointを通る。
- 認証済みhuman principalがない決定、自己承認、AI相互承認、別personaによる同一AIの承認を拒否する。
- AI actorによるapproval decisionをhuman-required actionへ使用できない。
- 承認receiptをpayload/effect hash、金額、宛先、回数、lease、期限へ束縛し、変更または再利用時は再承認する。
- 承認receiptにhuman principal、session/device、role、decision right、対象、上限、期限、evidence digestが残る。
- policy欠落・parse失敗はhuman-required候補をallowしない。

### Task 4: Unified Resource and Cost Accounting

**担当**: `claude-sonnet-4`  
**対象**:

- `libs/core/spend-guard.ts`
- OP-01 cost accounting
- mission ledger / CEO summary

LLM token費用だけでなく、次を共通 `resource_usage` として記録する。

- model/API/compute/SaaS利用料
- 広告・購入・外注のcommitted spend
- 人間作業時間
- AI実行時間、再試行、レビュー、失敗コスト

**受入条件**:

- actor、mission、customer、cost center別に集計できる。
- committed spendと実績費用を分離する。
- warnではなく、organization profileで指定したblock閾値を実行前に強制できる。
- 予算超過時は金額、成果、代替案を添えて人間にescalateする。

### Task 5: Solo CEO Control Surface

**担当**: `claude-sonnet-4`  
**対象**:

- `libs/core/ceo-surface-summary.ts`
- `libs/core/operator-home-summary.ts`
- concierge / Chronos / `pnpm kyberion`
- SU-01〜04、E2E-04

既存4フィードを次の会社運営ビューへ拡張する。

1. **Decide now**: 人間にしか決められない事項
2. **Exceptions**: AIが自律解決できなかった事項
3. **Outcomes to accept**: 受領・修正・却下待ち成果
4. **Workforce**: actor別の稼働、lease、品質、費用、停止状態
5. **Runway and commitments**: 予算、committed spend、期限、顧客約束

成果、承認、質問、失敗、顧客問い合わせ、期限超過は共通action queueへ投影し、`deadline × severity × value_at_risk × irreversibility` で決定論的に優先順位付けする。CLI、Concierge、Chronosはこの同じprojection APIを使い、別々の件数計算を持たない。

通知は全イベントを流さず、次の場合だけ即時通知する。

- human-reserved decision
- threshold超過
- irreversible action直前
- customer/legal/financial deadline risk
- repeated failureまたはconfidence不足
- security/secret/data egress例外

**受入条件**:

- ソロプレナーが「今日決めること、危険、届いた成果、現在費用」を1画面で把握できる。
- 全カードからowner、deadline、business outcome、mission/evidence、next actionへ到達できる。
- 承認にはAIの提案、根拠、反対意見、費用、不可逆性、期限を表示する。
- approve/rejectだけでなく、scope縮小、予算変更、期限変更、再委任、停止ができる。
- 日次briefと週次business reviewを同じ正本データから生成する。
- CLI、Concierge、Chronosのpending/exception/outcome件数がcontract testで一致する。

### Task 6: Outcome Acceptance and Accountability Receipt

**担当**: `claude-sonnet-4`  
**対象**:

- artifact bundle / mission review gates
- delivery / audit / knowledge distillation
- SU-03 deliverable inbox

mission状態を少なくとも次に分離する。

```text
executed -> validated -> awaiting_human_acceptance -> accepted
                                      \-> changes_requested
                                      \-> rejected
```

**受入条件**:

- AIが成果物を生成・検証しても、自動的にhuman acceptance済みにならない。
- acceptance receiptにaccountable owner、artifact digest、既知の制約、残余risk、受領時刻が残る。
- changes requested時は元mission/lease/evidenceへ相関した新work itemを作る。
- acceptance後のみ、顧客納品、正式記録化、durable knowledge昇格を許可するpolicyを設定できる。

## 6. 段階導入

| Wave | 内容                      | 完了基準                                                      |
| ---- | ------------------------- | ------------------------------------------------------------- |
| W0   | shadow inventory          | 現在のagent/team/missionをactor contractへread-only投影できる |
| W1   | accountability mandatory  | 新規missionにhuman accountable ownerが必須になる              |
| W2   | bounded delegation        | 全AI workが期限・scope・budget付きleaseを持つ                 |
| W3   | reserved decision enforce | 財務・契約・外部副作用でhuman approvalを強制する              |
| W4   | solo CEO UX               | decide/exception/outcome/workforce/runwayを1画面化する        |
| W5   | acceptance and learning   | human acceptanceから納品・記憶昇格まで閉ループになる          |

既存データは一括破壊migrationせず、W0で `actor_kind=ai_agent` と既定human ownerをshadow導出し、warning期間を経てW1で必須化する。

## 7. 非目標

- AIに法人格、法的責任、最終署名権を与えること
- 大企業向けHRIS、給与、複雑な組織階層をKyberion内に再実装すること
- 全AI操作を逐次人間承認にして自律性を失わせること
- AIの自己評価だけで品質・適法性・財務妥当性を確定すること
- provider/modelを恒久的な社員identityとして扱うこと

## 8. 成功指標

- human-reserved actionの無承認実行: 0件
- accountable owner不明のactive mission: 0件
- scope外・期限切れleaseによる実行: 0件
- ソロプレナーの定例確認時間: 1日15分以内を目標
- 通知のうち人間判断が必要な割合: 80%以上
- AI稼働のcost/outcome/exception相関可能率: 100%
- 成果物のhuman acceptance receipt付与率: 100%

## 9. 推奨着手順

最初の実装sliceは Task 1とTask 2の最小形に限定する。

1. `workforce-resource-ref` schemaを追加し、既存 `MissionStaffingAssignment` を正本へ昇格する。
2. organization profileへ唯一のhuman accountable ownerを登録する。
3. mission/work itemへresponsible/accountableを記録する。
4. 既存work leaseへscope、budget、expiryを追加する。
5. shadow modeのcontract testを通してから必須化する。

この土台がないままUIや業務テンプレートだけを増やすと、AIが何を任され、誰が責任を持ち、どこで止まるべきかを後付けすることになる。
