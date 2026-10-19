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

### Phase 3 — 共通ゲート接続 (部分実装)

- 推論境界はCharterにprocessor scopeが明示された場合、実provider ID・purpose・カテゴリを既存provider attestation/egress gateと合成する。scope未指定はunknown/missingとして拒否する。
- customer outboundはbinding済み顧客、本文カテゴリ、添付数をgateへ渡す。Charterの `allow_customer_outbound` は完全一致の定型挨拶のみ・添付なしを委任し、それ以外は承認へ戻す。
- payment、public publish、credential change 等は既存の金額・decision-rights・high-risk floorを維持。新Charterの public/customer recipient action は facts 欠落を拒否するが、すべての生産入口から具体的宛先/資産factsを渡す統合は未完了。
- op-preflight の単調 guard と全入口 coverage を使い、特定入口だけのすり抜けを防ぐ。

### Phase 4 — 運用ループ

- 監査から使用量、例外、結果を集計し、Charterの狭域化・停止提案を行う。拡張は責任者の再受諾が必須。
- 低影響の定型作業は自動実行、通知やサンプリング監査、高影響・曖昧・新規宛先は人へ戻す。
- Singapore IMDA、NIST AI RMF、EU AI Act、日本AI事業者ガイドライン等の適用範囲・強制力の差を明示して運用ガイドへ反映する。

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
- 既存の日次Accountability Reportに支出・拒否・停止・Charter amendment候補の通知がある。情報フロー拒否を理由付きで集計しCharterの狭域化/停止提案へ戻す運用接続は未実装。
- 支払上限の原子的消費も別途未実装。
- Phase 4 は監査結果に基づく自律度の縮小・停止・通知をつなぐ。実行失敗、再送、支出予約の競合を確認するまでは、金銭委任のトランザクション性を保証済みと表現しない。
- 上位モデルのレビューで確認した追加制約: `approval-gate` の信頼境界に型付き facts を追加し、`op-preflight` の単調拒否・sandbox・provenance・domain・spend・hardened policyを維持する。金額上限は実行時消費の原子性を別途評価する。

## 根拠資料

- Singapore IMDA, [Model AI Governance Framework for Agentic AI](https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai)
- NIST, [AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) / [Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- EU Commission, [Navigating the AI Act](https://digital-strategy.ec.europa.eu/en/faqs/navigating-ai-act)
- Japan PPC, [Generative AI services and personal data](https://www.ppc.go.jp/files/pdf/230602_alert_generative_AI_service.pdf)
- UK Government, [AI Playbook](https://www.gov.uk/government/publications/ai-playbook-for-the-uk-government/artificial-intelligence-playbook-for-the-uk-government-html)

各資料は適用対象と法的効力が異なる。ここでの原則はKyberionの設計への参照であり、法的適合の宣言ではない。
