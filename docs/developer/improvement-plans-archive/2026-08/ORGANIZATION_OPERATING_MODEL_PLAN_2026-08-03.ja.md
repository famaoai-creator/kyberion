---
title: Organization Operating Model Improvement Plan 2026-08-03
tags: [organization, purpose, operating-model, service, operation, project, governance]
last_updated: 2026-08-04
status: completed
---

# 組織オペレーティングモデル改善計画

## 1. 背景

今回の Project 管理機能によって、`Project → Track → Mission → Task / Task Session`
を一つの管理経路として扱える基礎ができた。しかし、組織で仕事を見ると、
Solution Project は組織活動の一部にすぎない。

組織には少なくとも次のような異なる時間軸と責任がある。

- 組織が存在する理由、目的、原則、戦略
- 組織が継続的に提供するサービスと業務能力
- 日々・週次・月次で繰り返す定常オペレーション
- 障害、問い合わせ、例外、危機への対応
- 新しいソリューションを作る Project
- 既存サービスや業務を改善する小さな変更・実験
- 意思決定、レビュー、監査、予算などの Governance Cadence

これらをすべて Project として扱うと、Project の終了条件に合わない継続業務が
埋もれる。逆に、すべてを Mission や Task として扱うと、組織の目的・責任者・
サービス水準・運用知識とのつながりが失われる。

既存の `Organization Work Loop`、`Enterprise Operating Kernel`、
`Organization Profile Model`、`Project Operating System` はそれぞれ有効である。
本計画はそれらを置き換えず、組織を起点に Project と定常運用を同じ Control Plane
から見られるようにするための接続計画である。

## 2. 目的

組織の目的から、継続的なサービス運用、変更 Project、例外対応、学習までを、
仕事の種類に応じた適切なライフサイクルで管理できる状態にする。

### 完了時の利用者体験

利用者は、例えば次のように依頼できる。

> 「この組織の目的に照らして、現在の重要な運用、進行中の Solution Project、
> 未解決の Incident、今週判断が必要な事項をまとめてください。」

Kyberion は、目的・組織・運用領域・サービスの文脈を解決し、仕事を
`solution_project`、`service_operation`、`routine_operation`、
`incident_response`、`governance_cadence`、`improvement_experiment` のいずれかに
分類する。その後、必要なものだけを Project、Operation、Incident、または
Governance の管理単位に昇格し、実行は既存の Mission / Task / Actuator に委譲する。

### 非目的

- 最初から完全な組織図、人事台帳、ERP を実装しない
- 既存の Project を Operation に名前だけ置き換えない
- すべての業務を新しい万能 `Work` オブジェクトに押し込まない
- 組織 Profile に実行ロジックやシェルコマンドを埋め込まない
- 組織の目的をモデルが勝手に変更・再定義しない

## 3. 概念モデル

```text
Organization
├─ Purpose / Principles / Strategy
├─ Operating Domains
│  ├─ Capabilities
│  └─ Services / Business Processes
│     ├─ Service Operations       継続的に価値を提供する
│     ├─ Routine Operations       定期・反復的に実行する
│     ├─ Incident Responses       例外・障害を収束させる
│     └─ Improvement Experiments  運用を改善する
├─ Solution Portfolio
│  └─ Solution Projects           新しい価値・変更を作る
└─ Governance Cadences             判断・承認・レビューを継続する
       ↓
Mission → Task / Task Session → Evidence / Artifact / Delivery
       ↓
Service health / Outcome accounting / Organizational learning
```

### 3.1 組織と組織 Profile の分離

`Organization Profile` は、組織に適用するデフォルト・ポリシー・チーム選択の
単位であり、組織の全業務の現在状態を格納する場所ではない。

| 概念                           | 責任                                                      |
| ------------------------------ | --------------------------------------------------------- |
| Organization Profile           | 既定の mission class、team、backend、operating principles |
| Organization Purpose           | 存在理由、長期成果、原則、戦略的な優先順位                |
| Organization Operational State | 現在のサービス状態、運用負荷、未解決事項、判断待ち        |
| Operating Domain               | 組織内の責任領域と能力の境界                              |
| Service / Process              | 継続的に提供・実行する対象とその品質                      |

### 3.2 Project と Operation は兄弟の長期管理単位

- `Project` は、変化を作るための期限付き管理単位。成功条件は成果物、能力獲得、
  移管、または明確な Outcome で表す。
- `Operation` は、継続的な成果を保つための管理単位。成功条件はサービス水準、
  処理の健全性、期限遵守、バックログ、エスカレーションで表す。
- `Incident` は、Service / Operation の異常を収束させる短期の対応単位。
  再発防止の変更は別の Improvement Project または Improvement Mission に分ける。
- `Governance Cadence` は、定期的な意思決定・レビュー・監査の単位。成果は決定、
  承認、差し戻し、フォローアップであり、Project の進捗ではない。

Mission はこれらの下で実行する共通の durable execution unit とする。ただし、
Mission の親を必須で Project に固定せず、`project_ref`、`service_ref`、
`operation_ref`、`incident_ref`、`cadence_ref` の関係によって責任範囲を表す。

## 4. 仕事の種類とライフサイクル

| Work Shape               | 目的                                   | 主な管理単位                        | ライフサイクル                                          | 主な完了条件                 |
| ------------------------ | -------------------------------------- | ----------------------------------- | ------------------------------------------------------- | ---------------------------- |
| `solution_project`       | 新しいソリューション・能力・変更を作る | Project / Track                     | initiate → define → build → validate → transfer → close | Outcome、移管、closure gate  |
| `service_operation`      | サービスを安定して提供する             | Service / Operation                 | establish → run → measure → improve → retire            | SLO、健康状態、運用証跡      |
| `routine_operation`      | 定型の反復業務を期限内に処理する       | Operation / Runbook                 | schedule → execute → verify → report                    | 処理完了、証跡、例外分類     |
| `incident_response`      | 障害・例外を安全に収束させる           | Incident / Mission                  | detect → triage → mitigate → resolve → review           | 復旧、影響記録、再発防止判断 |
| `governance_cadence`     | 意思決定・承認・監査を行う             | Cadence / Decision Record           | prepare → review → decide → follow-up                   | 決定記録、承認、未決事項     |
| `improvement_experiment` | 運用や成果を小さく改善する             | Experiment / Mission または Project | hypothesis → test → measure → adopt / rollback          | 根拠付き採否、学習記録       |

同じ依頼でも、現在の文脈で Work Shape は変わり得る。例えば「レポートを作る」は、
単発なら Task Session、月次なら Routine Operation、レポート基盤を作るなら
Solution Project になる。この分類を Intent Resolution の責任に置く。

## 5. 正本と状態の設計

### 5.1 新しく定義する最小の正本

第1段階では、次の5つを独立した大きなサブシステムにせず、宣言的な契約と
read model として追加する。

| 契約                     | 最小の内容                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Organization Purpose     | `organization_id`、purpose、principles、objectives、horizon、owner、approval state                      |
| Operating Domain         | domain identity、責任者、capabilities、service refs、policy refs                                        |
| Service / Process Record | outcome、owner、consumer、SLO/SLI、dependencies、runbook refs、lifecycle                                |
| Operation Record         | operation type、service/process ref、trigger/cadence、automation boundary、escalation、evidence outputs |
| Work Resolution          | work shape、context refs、authority class、proposed parent、confidence、human decision                  |

既存の `project-record.schema.json`、Mission / Track、Task Session、Project
Operational State を再利用し、Project だけが持つ前提を Work Resolution から外す。

### 5.2 Operational State の配置

組織の現在状態は knowledge と混ぜず、tenant / tier 境界を保った operational
state とする。

```text
active/organizations/<tier>/<tenant_or_shared>/<organization_id>/state/
  organization-state.json
  domains/<domain_id>/domain-state.json
  services/<service_id>/service-state.json
  operations/<operation_id>/operation-state.json
  incidents/<incident_id>/incident-link.json
  decisions/<decision_id>/decision-record.json
  evidence/
```

Project の state は既存の
`active/projects/<tier>/<tenant_or_shared>/<project_id>/state/` に残す。
組織 state は Project state の上位サマリを持つが、Mission や Service の全レコードを
複製する正本にはしない。参照関係、last observed、health、pending decision、
reconciliation status を保持する投影とする。

### 5.3 Tier / Tenant / Authority

- Purpose、組織プロファイル、サービス構成は、公開可能なテンプレートと
  tenant confidential な実値を分離する。
- URL、接続先、契約、顧客名、運用証跡は confidential 側に置く。
- Organization state、Service state、Incident evidence は tenant scope を必須にする。
- cross-tenant の集計や比較は、brokered / redacted な public scope へ明示的に昇格する。
- 組織目的、戦略、SLO、automation boundary の変更は、内容に応じた human approval
  を通過させ、実行 agent が直接変更しない。

## 6. 実装フェーズ

### OM-00: Vocabulary と関係モデルの固定（P0）

- `organization`、`domain`、`capability`、`service`、`operation`、`incident`、
  `cadence`、`project` の用語と関係種別を定義する。
- Project Management Control Plan に本計画へのリンクを追加し、Project が
  `solution_project` の一形態であることを明記する。
- 既存の `Organization Profile` と `Organization Purpose` の責任を分離する。
- 代表シナリオを6つ作る: ソリューション開発、月次レポート、定常監視、障害対応、
  経営レビュー、運用改善。

**完了条件**: 6シナリオで、Project 化するもの・Operation に残すもの・Mission
だけで終えるものを人間が説明できる。

### OM-01: Organization Purpose と Operational State（P0）

- Purpose / objectives / principles の schema と承認状態を追加する。
- organization state の tenant-aware path と read model を追加する。
- `organization show`、`organization purpose show`、`organization status` の
  read-only CLI / Core facade を追加する。
- 目的の変更履歴と、現在の目的に対する Outcome / metric の参照を残す。

**完了条件**: Control Plane が、組織の目的・現在の状態・人間の判断待ちを、
Project 一覧だけに依存せず表示できる。

### OM-02: Domain / Capability / Service Catalog（P1）

- Operating Domain、Capability、Service / Process の declarative catalog を追加する。
- Service ごとに owner、consumer、SLO / SLI、runbook、依存関係、tier、tenant を記録する。
- 既存の operations knowledge と runbook を service refs で接続する。
- Service が Project、Operation、Incident のどこから影響を受けているかを投影する。

**完了条件**: 重要サービスに owner、health signal、runbook、escalation path があり、
未登録の責任領域を reconcile が検出できる。

### OM-03: Operation Record と定常実行（P1）

- Continuous、scheduled、event-driven、governance の Operation Record を追加する。
- cadence / trigger、許可された automation、approval boundary、retry / escalation、
  evidence output を declarative に持つ。
- 実行は既存 Actuator / Pipeline / Mission に委譲し、Operation Record 自体に
  state-driven loop や shell を埋め込まない。
- runbook の一回分を Mission または Task Session として起動し、結果を Operation
  evidence と Service health に反映する。

**完了条件**: 月次定常業務を「Project を作って閉じる」ことなく、期限・担当・
証跡・例外・次回予定まで追跡できる。

### OM-04: Work Shape Resolution と Incident / Cadence（P1〜P2）

- Intent Resolution に Work Shape を追加する。
- Incident は Service / Operation の異常から作られ、mitigation と post-incident
  review を分離する。
- Governance Cadence は決定事項、承認者、期限、follow-up を管理する。
- confidence が低い、または authority class が高い場合は、実行前に人間へ返す。

**完了条件**: 同じ自然言語依頼でも、文脈と目的から適切な管理単位を選び、誤分類時に
dry-run と human correction で修正できる。

### OM-05: Organization Control Plane UX / Reconciliation（P2）

- Purpose、domain、service health、operations、incidents、decisions、solution
  projects を一つの operator read model にする。
- 「今、組織で何が起きていて、人間は何を判断すべきか」を最初に表示する。
- Organization / Service / Project / Operation / Mission の lineage を辿れるようにする。
- catalog、state、mission ledger、runbook、evidence の不整合を dry-run / apply で修復する。

**完了条件**: operator が Project Board を開かなくても、組織の運用上の重要事項と
介入点を把握できる。

### OM-06: Accounting / Learning の統合（P2〜P3）

- Operation の実績を Service outcome と Organization objective に集約する。
- Incident review、routine exception、project closure、governance decision を
  distill queue に送る。
- 安定した runbook、SOP、template、operator hint だけを承認付きで knowledge に昇格する。
- 目的やSLOの変更が実績と矛盾した場合に、再評価候補として提示する。

**完了条件**: 実行ログが単なる履歴で終わらず、次回の運用と組織の意思決定に再利用される。

## 7. Operator UX の基本画面

組織のトップ画面は Project 一覧ではなく、次の順序で構成する。

1. **Purpose** — 現在の目的、優先 Outcome、期間、変更待ちの承認
2. **Operating health** — Service / Operation の health、期限超過、未処理例外
3. **Change portfolio** — Solution Project と Improvement の進行状況
4. **Incidents / risks** — 影響、severity、owner、次の判断
5. **Decision queue** — 承認、レビュー、SLO・automation boundary の変更
6. **Learning** — 最近昇格した runbook、失敗パターン、再利用可能な知識

表示上も、以下の違いを説明する。

- Project は「変化を作る」
- Operation は「価値を保つ」
- Incident は「異常を収束させる」
- Cadence は「判断を続ける」
- Mission は「今この結果を出す」

## 8. CLI / Pipeline の候補

実装時の facade は、既存の Project CLI と Mission Controller の責任を奪わず、
組織コンテキストの入口として追加する。

```bash
pnpm organization show --json
pnpm organization status --json
pnpm organization domain list --json
pnpm organization service list --health --json
pnpm organization operation list --status active --json
pnpm organization work resolve --intent "今月の運用レポートを作る" --dry-run --json
pnpm organization reconcile --dry-run --json
pnpm organization learning enqueue --organization-id ORG-1 --tier confidential --tenant-slug tenant-acme --learning-id LEARN-1 --source-type incident_review --source-ref INC-1 --title "Incident review" --summary "Capture the approved learning" --target-kind sop_candidate --dry-run --json
pnpm pipeline --input pipelines/organization-operating-model-validation.json
```

Pipeline は既知の domain / service / operation 一覧に対する declarative な検証と
governance envelope を担当する。状態依存の繰り返し、retry、実績判定は typed
operation / actuator 側に置く。

## 9. ガバナンスと安全性

- Organization Purpose、Strategy、Service owner、SLO、automation boundary は、
  高信頼の変更対象として扱う。
- Routine Operation は、許可された範囲の read / prepare / reconcile まで自動化し、
  外部副作用、金銭、対外連絡、権限変更は approval gate を要求する。
- Incident Response は mitigation の速度を優先できるが、緊急権限と事後レビューを
  別々に記録する。
- Service health の入力は、tenant、tier、source timestamp、freshness、confidence
  を持つ。古い投影を現在値として扱わない。
- Organization read model は投影であり、Mission / Service / Project の正本を直接
  書き換えない。
- クロステナント集計は、目的・権限・redaction の証跡がある brokered path のみ許可する。

## 10. 指標

導入効果は Project 数だけで測らない。

| 指標                                | 意味                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| Purpose-to-work coverage            | 現在の重要な仕事が組織目的・Outcome に接続されている割合         |
| Service ownership coverage          | owner、SLO、runbook、escalation が揃った重要サービスの割合       |
| Routine completion / exception rate | 定常業務の期限内完了率と例外率                                   |
| Work-shape correction rate          | Intent Resolution の分類を人間が修正した割合                     |
| Unlinked work rate                  | Service / Project / Operation / Mission に接続されない仕事の割合 |
| Decision aging                      | 判断待ち・承認待ちが滞留している時間                             |
| Evidence freshness                  | Service / Operation の最新証跡が許容期限内か                     |
| Learning reuse rate                 | distill された runbook / pattern が再利用された割合              |

## 11. 受入検証

### 契約・構造

- Purpose、Domain、Service、Operation、Work Resolution の schema と examples がある。
- organization state の tier / tenant path が fail-closed である。
- Project state を組織 state にコピーせず、参照と投影でつながっている。
- `check:contract-schemas`、`check:tier-hygiene`、`check:catalogs`、reference drift が通る。

### シナリオ

1. 新しい Solution Project を組織目的と Service に紐付ける。
2. 月次の定常レポートを Operation としてスケジュールし、Evidence を残す。
3. Operation の失敗から Incident を作り、復旧と post-incident review を分ける。
4. SLO 変更を Governance Cadence と approval に送る。
5. Operation の改善候補を Improvement Experiment として比較し、採否を記録する。
6. tenant A の Service state を tenant B の operator が読めないことを確認する。

### 実行・UX

- Work Shape の dry-run が提案された管理単位、理由、authority class、次の質問を返す。
- operator surface が purpose、health、change、incident、decision、learning の順に表示する。
- read model の stale / missing / conflicting state が「要確認」として表示される。
- すべての外部副作用は approval、audit、evidence と紐付く。

## 12. 既存計画との関係

| 既存計画 / 文書                 | 本計画での位置づけ                                                       |
| ------------------------------- | ------------------------------------------------------------------------ |
| Project Management Control Plan | `solution_project` の管理 facade。OM-00 で上位の組織モデルと接続する     |
| Organization Work Loop          | Intent → Context → Resolution → … → Learning の親概念                    |
| Enterprise Operating Kernel     | 組織目的・承認・説明責任・学習の企業向け framing                         |
| Organization Profile Model      | 組織のデフォルトと policy。目的や現在状態とは分離する                    |
| Project Operating System        | Project 配下のWhy / What / How / Control / Evidence                      |
| Project Operational State Store | Project の live state。Organization state から参照する                   |
| Multi-Tenant Operations         | すべての organization / service / operation state に適用する境界         |
| Meeting Operations Playbook     | Governance Cadence や Routine Operation の実行 playbook として再利用する |

## 13. 実装状況

- 2026-08-03: 組織の目的、運用領域、Service / Process、定常 Operation、Incident、
  Governance Cadence、Solution Project を分離した概念モデルと実装フェーズを策定。
- 2026-08-03: OM-00 と OM-01 を実装。`organization-operating-model.json` に6つの
  Work Shape、7つの関係種別、6つの代表シナリオを固定し、Purpose / Operational State の
  schema、tenant-aware registry、read-only Core facade、`pnpm organization` CLI を追加した。
- 2026-08-03: `active/organizations/confidential/<tenant>/<organization_id>/state/` を
  tenant scope の protected prefix とし、異なる tenant の read/write を fail-closed にした。
- 2026-08-03: OM-02 を実装。Domain / Capability / Service と Service State の schema、
  tenant-aware registry、catalog integrity、runbook ref、health freshness、ownership の
  reconcile を追加した。
- 2026-08-03: OM-03 を実装。Continuous / Scheduled / Event-driven / Governance の
  Operation Record、Operation State / Run、automation boundary、evidence、期限超過の
  reconcile を追加した。
- 2026-08-03: OM-04 を実装。`organization work resolve --dry-run` で Work Shape、管理単位、
  confidence、authority class、human decision、次の質問を提案し、Incident / Cadence /
  Decision の参照整合性と承認待ちを管理 view に投影した。
- 2026-08-04: OM-05 を拡張。`organization reconcile` を dry-run / apply 対応とし、組織サマリの
  自動再投影だけを apply 可能にした。解決できない missing / stale / invalid refs は
  `blocked_issues` として人間に返し、Project / Service / Operation / Incident / Cadence /
  Mission の関係を `OrganizationManagementView.lineage` に投影した。
- 2026-08-04: OM-06 を拡張。Incident review、Routine exception、Project closure、Governance
  Decision を source とする tenant-scoped learning candidate schema / registry を追加し、
  `control_plane.outcome_accounting` と learning refs に接続した。`learning enqueue` は
  dry-run / apply を分け、knowledge への昇格は `proposed → approved → promoted` の
  人間承認境界に残した。
- 受入検証済み: 組織モデル focused test 10件、`typecheck`、`build:repo`、`@agent/core build`、
  `check:contract-schemas`、`check:catalogs`、tier / ESM / script integrity、CLI dry-run / apply。
- 2026-08-08: [PM / OM 実装レビュー受領記録](./reviews/PM-OM-REVIEW-20260808.ja.md) により受入レビュー完了。blocking finding はなし。
