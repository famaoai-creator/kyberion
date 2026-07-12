---
title: Agent・Persona・組織モデル統合改善計画
kind: improvement-plan
scope: repository
authority: proposed
phase: [alignment, execution]
tags: [agent, persona, perspective, wisdom, organization, team, routing]
owner: ecosystem_architect
mission_id: MSN-AGENT-PERSONA-MODEL-20260712
last_updated: 2026-07-12
---

# Agent・Persona・組織モデル統合改善計画

## 実装状況（2026-07-12）

基盤実装完了:

- `ContextSecurityScope`、provenance付き`GovernedContextFragment`、scope-first context pack compiler
- tenant、organization、project、mission、purpose、tierのfail-closed filter
- provider egress guard、output tier downflow guard、承認付きcontext promotion ledger
- 決定論的`resolveParticipantContext`とselection reason codes
- typed `perspective_fanout`と`typed_cross_critique`
- participant別context pack、cross-tenant/project/mission critique拒否、reasoning receipt
- 4系統のlogical agent profile (`control-plane-agent`, `reasoning-worker`, `surface-gateway`, `operations-agent`)
- mission team、staffing assignment、A2A payload、retry、best-of-N judge、execution ledgerへのparticipant context伝搬
- model registry routingを使うprofile-level provider/model非固定経路

互換性:

- 旧`a2a_fanout`は既存pipelineのため残すが、実行時warningを出すdeprecated compatibility pathとした。
- 既存agent profileは削除せず、新logical profileをorganization defaultまたはdeterministic resolverから選択できる。
- canonical writerは`security_scope`を必須出力する。旧artifactはmigration時にscopeを一意に導出できない場合fail closedとする。

## 結論

現在の問題は persona の定義不足ではなく、異なる概念が同じ `persona` / `role` という語で選択されていることである。初回の LLM に自由選択させず、次の順序で決定論的に解決する。

1. 誰が実行するか: `agent_profile`
2. 何を許可するか: `authority_role`
3. 組織で何を担うか: `organization_role`
4. 今回のミッションで何を担うか: `team_role`
5. どの観点で考えるか: `perspective`
6. どのモデルへ送るか: `reasoning_route`

`persona` はこの6項目の総称として使わない。ユーザーに見せる人格表現が必要な場合だけ、解決結果から `presentation_persona` を生成する。

## 現状診断

### 1. 同名概念が複数の意味を持つ

- `libs/core/types.ts` の `Persona` は6種の実行権限主体である。
- `authority-role-index` も実行権限を表し、責務が重複している。
- `personalities/matrix.md` は27種の思考視点を定義する。
- `personalities/roles.json` は組織職能、capability、口調を一つのレコードへ混在させる。
- `team-role-index` はミッション内責務を表す。
- `agent-profile-index` は実行主体、権限、team role、provider/model 選択を一つに束ねる。
- `specialist-catalog` はユーザー要求のルーティング先だが、agent と team role の双方を参照する。

そのため初回 LLM は「Ecosystem Architect」を権限、組織職、視点、Agent のどれとして使うか判断できない。同じラベルを選べても意味が安定しない。

### 2. wisdom の persona が非正規化されている

`wisdom:a2a_fanout` は `personas: string[]` をそのまま reasoning backend へ渡す。`legal_strategist` が組織職なのか思考視点なのかは契約上判別できない。`cross_critique` も同じ問題を引き継ぐ。

一方、`wisdom:a2a_roleplay` の `persona` は合成された相手人物仕様であり、fanout の persona とは別概念である。現在は同じ語のため、組織メンバーの検討と外部相手の模擬会話が混同されやすい。

### 3. Agent roster が責務ではなく利用場面で増殖している

`planner-agent`、`attacker`、`defender` は永続的な実行主体というより team role / perspective である。Slack、Telegram、Onboarding などの surface agent は会話入口であり、推論主体とは限らない。`nerve-agent` と `sovereign-brain` も coordination 能力が重複する。

このまま Agent を追加すると、同じ LLM backend を別名で起動するだけの構成が増え、選択理由、所有権、コストが不透明になる。

### 4. 組織図とミッションチームの境界が崩れる

`org-chart.ts` の派生組織図は team role を組織 position として補完する。このため、長期的な所属・決裁系統と、一時的な mission assignment が同じ組織図に見える。組織の `Product Manager` とミッションの `planner` は関連するが同一ではない。

## 目標モデル

| 概念                   | 寿命             | 選択者               | 主な責務               | 例                                    |
| ---------------------- | ---------------- | -------------------- | ---------------------- | ------------------------------------- |
| `agent_profile`        | プロセス・常駐   | runtime              | 実行方式と接続面       | `reasoning-worker`, `surface-gateway` |
| `authority_role`       | セッション・実行 | policy engine        | I/O・actuator 権限     | `software_developer`                  |
| `organization_role`    | 組織・長期       | organization profile | 職務、決裁、報告先     | `product_manager`                     |
| `team_role`            | mission・一時    | team composer        | 成果物責任と委譲境界   | `planner`, `reviewer`                 |
| `perspective`          | reasoning turn   | perspective resolver | 思考観点と評価基準     | `ruthless_auditor`                    |
| `counterparty_profile` | rehearsal        | wisdom synthesizer   | 模擬相手の行動特性     | 顧客担当者モデル                      |
| `presentation_persona` | surface/session  | UX resolver          | 名前、口調、声、avatar | オンボーディング案内役                |
| `reasoning_route`      | dispatch         | model router         | provider/model/budget  | `high-confidence`                     |

### 解決順序

```text
user intent
  -> organization context
  -> mission classification
  -> organization_role candidates
  -> team_role composition
  -> agent_profile binding
  -> authority preflight
  -> security_scope compilation
  -> perspective set
  -> reasoning_route
  -> provider egress preflight
  -> dispatch
```

後段から前段を推測しない。provider/model は Agent のアイデンティティではなく、最後に policy で選ぶ実行資源とする。`security_scope` はpersonaの一種ではなく、すべてのparticipant、context fragment、dispatchを包む強制的な情報流制御envelopeとする。

## Agent roster の再編案

### 常設する実行主体

1. `control-plane-agent`
   - mission owner、routing、checkpoint、escalation を担当する。
   - 現在の `sovereign-brain` と `nerve-agent` の重複を整理する。
2. `reasoning-worker`
   - planner、implementer、reviewer、attacker、defender 等の team role / perspective を実行する汎用 worker。
   - 現在の `implementation-architect`、`planner-agent`、`attacker`、`defender` を overlay 化する。
3. `surface-gateway`
   - Presence、Slack、Telegram、Onboarding 等の channel adapter を束ね、会話状態と approval を扱う。
   - channel 固有 agent は deployment profile または adapter とする。
4. `operations-agent`
   - daemon、health、restart、runtime 操作を担当する。
   - `chronos-mirror` の運用面を明確化する。

これは物理プロセスを必ず4個にするという意味ではない。論理的 identity を4系統に限定し、必要な並列数は runtime instance として増やす。

### Agent にしないもの

- `planner`, `reviewer`, `attacker`, `defender`: `team_role` または `perspective`
- `Product Manager`, `Legal Strategist`: `organization_role`
- `Ruthless Auditor`, `Pragmatic CTO`: `perspective`
- `browser-operator`, `document-specialist`: capability bundle を持つ `specialist_profile`
- 顧客や交渉相手: `counterparty_profile`
- 声、avatar、口調: `presentation_persona`

## wisdom 連携の改善

### 新しい dispatch contract

wisdom の発散・批評 API は自由文字列の `personas` を廃止し、次を受け取る。

```json
{
  "participants": [
    {
      "participant_id": "security-review",
      "organization_role_id": "cyber_security",
      "team_role_id": "reviewer",
      "perspective_ids": ["security_attacker", "rigorous_validator"],
      "agent_profile_id": "reasoning-worker",
      "authority_role_id": "ecosystem_architect",
      "reasoning_route_id": "high-confidence",
      "security_scope": {
        "tenant_id": "tenant-a",
        "project_id": "project-x",
        "mission_id": "MSN-123",
        "read_tiers": ["public", "confidential"],
        "write_tier": "confidential",
        "purpose": "security-review"
      }
    }
  ]
}
```

backend へ渡す prompt はこの contract からコンパイルする。LLM はカタログ ID を発明せず、未解決 ID は dispatch 前に失敗させる。

### tier・tenant境界を守るcontext pack

Agent間で会話履歴そのものを共有しない。受信participantの`security_scope`に合わせて`ContextPackCompiler`が再構成したcontext packだけを渡す。

各context fragmentは最低限、次のprovenanceを持つ。

```json
{
  "fragment_id": "CTX-001",
  "source_ref": "knowledge/confidential/tenant-a/project-x/decision.md",
  "source_tier": "confidential",
  "tenant_id": "tenant-a",
  "project_id": "project-x",
  "mission_id": "MSN-123",
  "purpose_tags": ["security-review"]
}
```

情報流ルール:

- semantic retrievalより先にtenant、project、mission、tier、purposeでscope filterする。
- 同じ`confidential`でもtenantまたはprojectが異なれば既定で共有しない。
- `personal -> confidential/public`と`confidential -> public`は通常dispatchでは拒否し、承認付きpromotionだけを許可する。
- 出力tierは入力fragment中の最も機密性が高いtier以上に固定する。
- tier、tenant、provenance、provider egress policyのいずれかが不明ならfail closedとする。
- provider failover時はpromptをそのまま転送せず、候補providerごとにegress preflightとredactionを再実行する。
- conversation memoryは`tenant_id + organization_id + project_id + mission_id + participant_id + tier + purpose`でpartitionする。

fanoutではparticipantごとに別context packを生成する。cross-critiqueでは他participantの生出力を直接渡さず、受信側scopeへ投影できたcritique artifactだけを共有する。実Agent A2Aでも同じ境界を適用し、送信側の権限だけで共有可否を決めない。

すべてのdispatchでpreflightとoutput guardを二重化する。

```text
governed sources
  -> scope filter
  -> context pack compile / redact
  -> dispatch preflight
  -> reasoning backend or Agent
  -> output classification / leak scan
  -> tier-safe persistence or promotion gate
```

### operation の意味を分離する

- `wisdom:perspective_fanout`: 複数の思考観点による仮説生成
- `wisdom:cross_critique`: 同じ participant contract を使う相互批評
- `wisdom:counterparty_synthesize`: 外部人物の模擬 profile 生成
- `wisdom:counterparty_roleplay`: 合成済み profile との対話
- `agent:delegate`: 実在する Agent instance への作業委譲

「複数視点を一つの backend で生成すること」と「複数 Agent が独立に会話すること」を receipt 上でも区別する。前者は reasoning ensemble、後者は A2A collaboration である。

### 品質とコスト

- 通常は `team_role` ごとに1 perspective を決定論的に割り当てる。
- 高リスク時だけ attacker/defender、devil's advocate、independent reviewer を追加する。
- 同じ backend による fanout は diversity が限定的であることを receipt に記録する。
- provider diversity が必要な場合は `reasoning_route` に `independent_backends: true` を明示する。
- `stub` はテスト専用とし、成果物には `reasoning_mode` を必須記録する。

## 組織・チームとの関連

組織は人や常設 Agent の長期責務と決裁線を持つ。ミッションチームはその組織から必要な責務を一時的に借りる。

- `organization_profile`: 利用可能な organization role、決裁者、既定 routing policy
- `mission_team_template`: 必要な team role と review separation
- `staffing_assignment`: organization role / agent instance を team role に割り当てた事実
- `execution_ledger`: 実行時の agent、authority、perspective、model route を記録

一人または一つの Agent が複数 team role を兼任できるが、`implementer` と独立 `reviewer` のような分離要件は staffing validator が拒否する。

## 初回 LLM を迷わせない仕組み

1. 起動時に LLM へ全 persona 一覧を渡さない。
2. deterministic resolver が intent、organization、risk から候補を最大3件に絞る。
3. 既定値が一意なら質問せず採用する。
4. 選択が成果・権限・コストを変える場合だけユーザーへ確認する。
5. LLM には `resolved_participant_context` と task brief のみ渡す。
6. 選択理由を `routing-decision.json` に記録する。

最低限の初期 context は次とする。

```json
{
  "agent_profile_id": "reasoning-worker",
  "authority_role_id": "worker",
  "organization_role_id": null,
  "team_role_id": "planner",
  "perspective_ids": ["pragmatic_cto"],
  "reasoning_route_id": "default",
  "security_scope": {
    "tenant_id": "default",
    "project_id": null,
    "mission_id": "MSN-EXAMPLE",
    "read_tiers": ["public"],
    "write_tier": "public",
    "purpose": "mission-planning"
  },
  "selection_reason_codes": ["DEFAULT_CODE_CHANGE_PLANNER"]
}
```

## 実装計画

### Phase 0: 用語固定と観測のみ

- canonical glossary と JSON schema に上記8概念を追加する。
- 既存 `Persona` を直ちに削除せず `execution_principal` の deprecated alias と定義する。
- 現在の dispatch receipt に、各 persona 値がどの namespace 由来かを記録する。
- 現在のdispatch receiptに入力・出力tier、tenant、project、mission、provider egress判定を記録する。
- `a2a_fanout` の自由文字列利用を計測し、未解決 ID を warning にする。

受入条件: 同じ文字列がどの namespace で解釈されたか、どのscopeの情報がどのproviderへ渡ったかを全dispatchで追跡できる。

### Phase 1: canonical resolver

- `participant-context.schema.json` と `routing-decision.schema.json` を追加する。
- `security-scope.schema.json`と`context-fragment.schema.json`を追加し、`participant-context`から必須参照する。
- `resolveParticipantContext(intent, organization, teamRole, risk)` を core に実装する。
- `compileContextPack(participantContext, candidateFragments)`をcoreに実装し、scope filterをsemantic retrievalより先に適用する。
- organization role -> team role -> perspective の明示 mapping catalog を追加する。
- selection reason code と候補棄却理由を返す。

受入条件: cold start の代表シナリオでLLMを使わず一意なparticipant contextが得られ、異tenant・異project・上位tierのfragmentがcontext packへ混入しない。

### Phase 2: wisdom contract 移行

- `perspective_fanout` を追加し、typed participants を reasoning backend へ渡す。
- `a2a_fanout` は互換 adapter とし、文字列を namespace 解決して warning を出す。
- counterparty operation と perspective operation の schema を分離する。
- reasoning ensemble と実 Agent A2A を異なる event type で記録する。
- fanout participantごとにcontext packを個別コンパイルする。
- cross-critiqueとA2Aにscope projectionを追加し、生出力の横流しを禁止する。
- provider failoverごとにegress preflightを再評価し、許可されないproviderへの転送を止める。
- output guardで出力tierを分類し、低いtierへの保存をpromotion gateへ送る。

受入条件: 未登録perspectiveまたはscope不明のdispatchはpreflightで拒否され、fanoutの各出力にparticipant、backend、入力・出力scope、redaction結果が残る。

### Phase 3: roster 縮約

- 4系統の logical agent profile を追加する。
- 既存 profile に `kind: core | compatibility | adapter` と後継 ID を付ける。
- planner/attacker/defender を overlay として実行できるようにする。
- channel-specific profile を surface deployment config へ段階移行する。

受入条件: 既存 mission template の構成結果を維持しつつ、新 roster で同じ team role を充足できる。

### Phase 4: organization staffing 統合

- org chart の `position` と mission `team_role` を別 schema に固定する。
- staffing assignment に `organization_role_id`、`agent_instance_id`、`perspective_ids` を追加する。
- 職務分離、決裁、escalation path を validator で検証する。
- organization template は Agent 名ではなく role/capability requirement を持つ。

受入条件: 組織変更で mission template を書き換えず、staffing のみ再解決できる。

### Phase 5: onboarding と運用 UI

- ユーザーには Agent 数ではなく「常設機能」「組織職」「一時チーム」「思考視点」を別画面で示す。
- 既定構成を先に提示し、高度設定でのみ model/perspective 優先度を編集可能にする。
- routing receipt から「なぜこの Agent / 視点 / model か」を表示する。

受入条件: 初回設定で persona の自由記述を要求せず、既定構成で first win まで到達できる。

## 移行時の互換性

- `Persona`、`assigned_persona`、`personas` は一度に rename しない。
- reader は旧新双方を受け、writer は新形式を出す read-old/write-new 方式にする。
- compatibility mapping に namespace、移行先、廃止予定 version を持たせる。
- 旧形式から`security_scope`を一意に導出できない場合は広い既定値を補完せず、明示設定またはoperator確認を要求する。
- `agent-profile-index` 等の snapshot は canonical directory から生成し、手編集対象を増やさない。
- telemetry で旧フィールド利用がゼロになってから schema から削除する。

## 優先順位

最優先は Agent の追加・削除ではなく Phase 0〜2 である。意味が曖昧なまま roster だけ整理すると、wisdom と organization 側で同じ混乱が再発する。

推奨順序:

1. typed participant context と resolver
2. wisdom の perspective / counterparty 分離
3. context pack compilerとtier/tenant enforcement
4. execution receipt の観測性
5. Agent roster 縮約
6. organization staffing 統合
7. onboarding UI

## リスク

- 既存の `persona` は security boundary に使われるため、単純 rename は権限逸脱を招く。
- Agent profileの共有範囲を広げてもcontext memoryを共有してはならない。security boundaryはAgentではなくdispatch単位に固定する。
- 同じtier名だけでは隔離にならない。tenant、project、mission、purposeを含む複合scopeを必須にする。
- 1 backend 内の multi-persona は独立 Agent の合議ではない。UI と監査ログで明示する。
- roster 縮約で surface の障害分離を失わないよう、logical identity と deployment process を分ける。
- perspective を増やしすぎると token cost と収束時間が増える。risk policy で上限を決める。
- organization role を prompt tone に直結するとステレオタイプ化する。職務責任と表現人格を分離する。

## 検証シナリオ

1. cold start のコード修正: `reasoning-worker + worker + implementer + pragmatic_cto` が質問なしで選ばれる。
2. 高リスク security review: attacker と defender が別 participant として選ばれ、独立 review 制約が働く。
3. 契約レビュー: legal/finance/security の organization role が perspective contract に変換される。
4. 顧客交渉 rehearsal: counterparty profile が organization member と混同されない。
5. Slack intake: surface gateway が推論を抱えず control plane へ委譲する。
6. provider outage: Agent identity を変えず reasoning route だけ failover する。
7. 一人組織: 同一 actor の兼任は許すが、職務分離が必要な gate は人間承認へ上げる。
8. 異tenant fanout: `confidential/tenant-a`のfragmentがtenant-b participantへ渡らない。
9. cross-tier critique: personal入力由来の生出力がpublic participantへ渡らず、promotionなしでは保存もされない。
10. provider failover: local許可・external禁止のcontextが外部providerへの切替時に遮断される。
11. semantic retrieval: 類似度が高くてもscope外fragmentが検索候補から除外される。

## 完了条件

- 初回 LLM が自由文字列 persona を選択する経路がない。
- Agent、権限、組織職、team role、perspective、counterparty、presentation、model route が schema 上で区別される。
- wisdom の全 reasoning output が participant context と backend route を追跡できる。
- 全context fragmentにtier、tenant、provenanceがあり、scope filterがsemantic retrievalより先に強制される。
- fanout、cross-critique、A2A、provider failoverの全経路でdispatch preflightとoutput guardが動作する。
- cross-tier共有は通常dispatchでは行われず、承認付きpromotion ledgerからのみ追跡可能に実行される。
- organization profile から mission staffing への変換が説明可能である。
- 既存 mission / surface の互換テストを維持しながら旧 persona field を段階廃止できる。
