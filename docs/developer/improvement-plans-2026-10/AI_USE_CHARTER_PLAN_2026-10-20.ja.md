---
title: AI Use Charter — 情報処理境界と自律実行の統合
tags: [ai-governance, charter, autonomy, egress, accountability]
last_updated: 2026-10-20
status: active
---

# AI Use Charter — 情報処理境界と自律実行の統合

## 目的

責任者憲章(Accountability Charter)の委任範囲を、モデル推論への情報提供と、AI が起こす外部操作の両方に一貫して適用する。外部 API への推論を一般公開と同一視せず、モデル提供者への処理委託と、顧客・一般への送信を別の判断として扱う。責任者は業務単位の委任境界を事前に決め、範囲内は自動実行、例外や重大な判断だけを人に戻す。

## 現状の確認

- `accountability-charter.ts` は責任者、権限、金額、データtier、外部効果、可逆性、損失、評判、影響範囲を評価する。
- `approval-gate-charter.ts` は憲章の範囲内の操作を承認なしで通し、範囲外を従来の承認ゲートに戻す。customer outbound には既に責任者憲章の接続がある。
- `provider-egress-gate.ts` と `reasoning-egress-scope.ts` は、モデル提供者・テナント・データtier・`training_use` を使って推論データの送信を制御する。
- `egress-policy.ts` は送信先・audience の制約を別に持つ。
- ただし、`ReasoningPayloadScope.training_use: 'zero_retention'` を、provider attestation の `training_use: 'none'` だけで通している。これは「学習に使わない」と「保存しない」を混同しており、呼び出し側の要求語彙を修正する。
- Accountability Charter の action context は、モデル処理先・保持条件・目的・具体的な受領者/資産をすべて結合する共通事実モデルではない。これらを一つのスコアへ潰すのではなく、各既存ゲートの根拠として接続する必要がある。

## 設計原則

1. **処理先と受領者を分ける**: モデル提供者は processor、メール宛先や一般公開先は recipient/audience。推論APIの利用だけで公開扱いにしない。
2. **情報の属性を行為の属性と分ける**: 情報資産/tier、目的、処理条件、処理先、最終受領者、操作の影響・可逆性を独立に評価する。
3. **学習利用・保持・人によるアクセス・処理地域を別の条件にする**: `training_use: none` は非学習の根拠だけを表し、ゼロ保持や法令適合を含意しない。
4. **禁止条件は点数と相殺しない**: テナント境界、契約・法令、未承認processor、秘密情報、Charterで明示していない操作はハードな拒否/エスカレーション条件とする。
5. **Charterが範囲内の自律性を与える**: 人は責任者、利用目的、許可データ、processor条件、受領者クラス、操作別上限、停止条件を事前に受諾する。毎回の承認は例外に限定する。
6. **モデルは分類を助け、コードが強制する**: AIはデータ・宛先・目的の候補を抽出できるが、曖昧・欠落・矛盾がある事実を勝手に許可へ変換しない。
7. **監査・縮退・取消を維持する**: 決定根拠、Charter版、processor/recipient識別子、使用量、結果を記録。異常時は自律度を下げ、責任者が停止・取消できる。

## 判定の形

```text
推論データの送信:
  tenant/tier と資産の範囲
  → 目的
  → processor の識別・学習利用・保持等の attestation
  → provider/egress policy
  → allow / allow-and-log / require-human / deny

AI による外部操作:
  action + 情報資産 + 受領者/audience + 目的
  → 法令/テナント/approval のハード制約
  → Accountability Charter の権限・金額・appetite
  → allow / allow-and-notify / require-human / deny
```

二つの経路は監査イベント上で相関づけるが、processor を顧客受領者として扱わず、推論の許可を最終送信の許可へ転用しない。

## 実装フェーズ

### Phase 1 — 非学習とゼロ保持を区別する (この変更)

- Reasoning payload の `no_training` を明示し、provider attestation の `training_use: 'none'` が保証する意味を非学習に限定する。**実装済み**。
- `zero_retention` は推論経路で非学習の別名として使わない。実際の保持条件を裏付ける型・証跡が導入されるまでは fail-closed とする。**実装済み**。
- peer auto-reply と discussion の confidential 推論は、意図している非学習条件を明示する。**実装済み**。
- 回帰テストで `no_training` の許可には有効なテナント attestation が必要であること、`local_only` は外部送信を止めること、ゼロ保持要求が非学習だけで通らないことを確認する。**対象テスト実行済み**。

### Phase 2 — Charter の情報流エンベロープ (実装済み)

- Charter に purpose、データカテゴリ、許可 processor/処理目的、受領者クラス、添付上限を追加した。Charter formの受付・署名文・生成にも反映した。
- parent/child Charter の情報フローはsubset検証され、未指定の受領者やprocessorは許可しない。
- `evaluateAgainstCharter` が型付きfactsを評価し、既存 `approval-gate-charter` でdenyを承認要求へ戻す。caller payloadのapprovalフラグは信頼しない。

### Phase 3 — 共通ゲート接続 (実装済み)

- 推論境界はCharterにprocessor scopeが明示された場合、実provider ID・purpose・カテゴリを既存provider attestation/egress gateと合成する。scope未指定はunknown/missingとして拒否する。**実装済み**。
- customer outboundはbinding済み顧客、本文カテゴリ、添付数をgateへ渡す。Charterの `allow_customer_outbound` は完全一致の定型挨拶のみ・添付なしを委任し、それ以外は承認へ戻す。**実装済み**。
- すべての生産入口がfactsを渡す: `approval:evaluate_decision_rights` に信頼済み `information_flow`(purpose/recipient_class/processor_id/categories/attachment_count)入力を追加し、`confirm-appointment-calendar` テンプレートが申告する。facts欠落のrecipient actionは人へ戻る。**実装済み**。
- Charter formは受領者スコープ(`recipient_purposes`/`recipient_classes`/`recipient_categories`/`max_attachments`)を明示的に委任でき、署名文と envelope に反映する。`known_counterparty`(既知の社外当事者)を受領者クラスに追加した。**実装済み**。
- payment、public publish、credential change 等は既存の金額・decision-rights・high-risk floorを維持する。**維持**。
- 金額上限の読み取り・判定・消費を憲章スコープ単位のプロセス間ロック(`withCharterDecisionLock` / `decideUnderCharter`)で一つのクリティカルセクションにし、同時実行で同じ残枠を二重消費できないようにした。**実装済み**。
- 信頼境界の単調性: `enforceApprovalGate` は untrusted payload の `information_flow` を action に合成しない(回帰テストで固定)。情報境界の語彙entryはfacts無しで自動許可されないことを全entryのテストでカバーする。**実装済み**。

### Phase 4 — 運用ループ (実装済み)

- Accountability Reportが情報フロー拒否を理由・purpose・受領者クラス・processor・カテゴリ別に集計する。委任済みスコープで反復する拒否は狭域化(narrow)提案、頻発(≥5)は停止(stop)提案として出す。拡張の提案はせず、適用は責任者の再受諾が必須。**実装済み**。
- 低影響の定型作業は自動実行し、外部効果のある自律実行は相関IDで決定的にサンプリング(5%)して運用者へ通知する。高影響・曖昧・新規宛先は従来どおり人へ戻す(appetite/不可逆/未委任purpose・class・categoryでfail-closed)。**実装済み**。
- 適用範囲・強制力の差を運用ガイド([ai-use-charter-operations.md](../../../knowledge/product/governance/ai-use-charter-operations.md))に反映した。**実装済み**。

## 受入条件

- 「非学習」「ゼロ保持」「外部API」「顧客送信」「一般公開」が異なる意味としてコードと設定に現れる。
- vendor quote に会社名があることだけではモデル推論を拒否せず、Charter・tier・provider条件に基づいて判断する。
- 許可済み顧客への定型挨拶は、責任者が定めた宛先・用途・内容・頻度の枠内で自動化できる。
- 新規/不明のprocessor・recipient、添付の追加、機密情報の外部送信、上限超過、policy変更は範囲内に見せかけて自動化できない。
- 憲章がない既存スコープの挙動と既存のハード制約を緩めない。

## 実装状況と次のゲート

- Phase 1 は推論の `no_training` と `zero_retention` の意味を分け、非学習証跡を保持証跡として誤用しない修正。confidential/personal の非学習要求は、テナントのprovider attestation、provider egress policy、domain egress policyを通す。public の経路とlocal endpointは既存の公開データ/ローカル処理ルールに従う。
- Charter情報フロー型/評価、子憲章の縮小検証、provider/purpose/categoryの設定・署名、推論境界との合成を実装した。
- 顧客送信の現行 `deliver(text)` には添付機能がないためattachment_count=0を境界で固定。添付送信追加時は実ファイルのtier/category評価を追加する。
- 顧客本文分類は厳密な定型挨拶allowlistのみ。未知本文をモデル分類で自動許可しない。
- processorのCharter許可は非学習/保持attestationの代替にならない。purpose/categoriesはモデル出力ではなく信頼済み呼び出し側の明示値が必要で、現時点ではすべてのreasoning呼び出しにpurpose/categoryを補っていない。
- processor許可はprovider descriptorのendpoint originに束縛し、Charterのstanding stop tripwireを推論egressでも確認する。新Charterのrecipient actionはrecipient factsを必須とし、processor factsで代用できない。
- legacy Charter（information_flowなし）は既存の受諾済み権限を維持する。新規Charterはprocessor未選択を空リストとして記録し、外部processor利用を閉じる。
- 新規Charterで `send_message_external` / `publish_public` を委任しても、呼び出し側が信頼できるrecipient factsを渡さない限り人へ戻る。受領者スコープはCharter form(`recipient_*`)で明示的に委任し、`approval:evaluate_decision_rights` がfactsを渡す。factsの形が不正な場合は「facts無し」へ落とさず入力エラーにする。
- 既存の日次Accountability Reportに支出・拒否・停止・Charter amendment候補の通知がある。情報フロー拒否を理由付きで集計し、狭域化/停止提案へ戻す運用接続を追加した。
- 金額上限の読み取り・判定・消費は憲章スコープ単位のロックで一つのクリティカルセクションにした。支払の実行そのもの(外部決済の確定)とゲートの消費記録は別プロセスであり、実行失敗時の補償は別途の課題として残る。
- Phase 4 は監査結果に基づく自律度の縮小・停止・通知(決定的サンプリング通知)をつなぐ。実行失敗・再送・支出予約の競合に対する金銭委任のトランザクション性は、決済側の補償設計が入るまで保証済みとは表現しない。
- 未実装として残るのは: Concierge UIでの受領者スコープ入力(現在はAPI経由)、決済実行側の補償/取消、`op-preflight` の専用単調guardの追加登録(現状はゲート内fail-closedとentrypoint testで担保)。

## 根拠資料

- Singapore IMDA, [Model AI Governance Framework for Agentic AI](https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai)
- NIST, [AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) / [Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- EU Commission, [Navigating the AI Act](https://digital-strategy.ec.europa.eu/en/faqs/navigating-ai-act)
- Japan PPC, [Generative AI services and personal data](https://www.ppc.go.jp/files/pdf/230602_alert_generative_AI_service.pdf)
- UK Government, [AI Playbook](https://www.gov.uk/government/publications/ai-playbook-for-the-uk-government/artificial-intelligence-playbook-for-the-uk-government-html)

各資料は適用対象と法的効力が異なる。ここでの原則はKyberionの設計への参照であり、法的適合の宣言ではない。
