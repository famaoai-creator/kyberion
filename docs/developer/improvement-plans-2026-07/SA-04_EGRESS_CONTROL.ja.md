# SA-04: データ持ち出し(egress)制御

> 優先度: P1 / 規模: M / 依存: なし / 関連: SA-02(ADF ガードレールが egress ポリシーを参照)、tier 分離(WHY.md の中核主張)

## 背景と課題

機密データが任意ホストへ送信されるのを防ぐ仕組みに穴がある。`secureFetch`(`libs/core/network.ts:107-150`)が全アクチュエータ共通の送信路。

- **egress allowlist が認証リクエストにしか適用されない**(HIGH): `network.ts:114-126` の `allowed_domains` チェックは `hasAuth === true`(Authorization/X-API-KEY ヘッダ等)の時だけ走る。**認証ヘッダの無い素の POST は allowlist を一切通らず**、`validateUrl`(SSRF/private-IP ブロック)とサイズ上限だけで任意の公開ホストへ送信できる。機密データの持ち出しがドメインポリシーで止まらない。
- **redaction がパターンベースで分類ベースでない**: `redactSensitiveObject`(`:68-95`)は既知シークレットキー名とシークレット形状トークン(`sk-`, `AIza`, JWT 等)を除去するが、**機密の業務データ(顧客 PII、案件条件)は正規表現にマッチせず素通り**する。
- SSRF 保護は妥当(`validateUrl:451-501` が localhost/private IP をブロック)だが、`KYBERION_ALLOW_LOCAL_NETWORK=true` で全無効化でき、DNS リバインディング(ホスト名検査で解決 IP 未検査)は未対応。
- サイズ上限(既定 2048KB)は一括持ち出しの量を制限するが low-and-slow な漏洩は防げない。

## ゴール(受入条件)

1. egress allowlist が**認証有無に関わらず全 `secureFetch` に適用**される。allowlist は `knowledge/product/governance/egress-policy.json` に集約(既存サービス preset のドメイン + 明示追加)。非該当ホストへの送信は既定ブロック(承認で override)。
2. confidential tier 文脈からの送信に**追加ゲート**: 送信ペイロードに confidential 由来データが含まれる場合、宛先が当該テナントの許可ドメインでなければブロック/承認要求。
3. DNS リバインディング対策(解決 IP の再検証)と `KYBERION_ALLOW_LOCAL_NETWORK` の適用範囲限定(開発時のみ・警告付き)。
4. egress の監査: 全外部送信が宛先ホスト・サイズ・tier・承認有無とともに監査記録される。

## 実装タスク

### Task 1: allowlist の全リクエスト適用 — `claude-sonnet-4`

1. `network.ts:114-126` の allowlist チェックを `hasAuth` 条件から外し、**全 `secureFetch` に適用**する。allowlist は `egress-policy.json`(新設、スキーマは `schemas/`)から読み、サービス preset のドメイン(`service-endpoints`)を起点に自動収集 + 手動追加。
2. 非該当ホストは既定ブロック(`KYBERION_EGRESS_POLICY=warn|enforce`、既定 warn で観測 → enforce の段階導入。enforce 到達を完了条件とする)。ブロック時は AC-01 形式の分類エラー(「未許可の送信先 <host>。egress-policy.json に追加するか承認を得てください」)。
3. test: 認証あり/なし双方で allowlist が効くこと、非該当ブロック、warn/enforce。

### Task 2: confidential データの持ち出しゲート — `claude-sonnet-4`

1. 送信呼び出し元が tier 文脈(mission tier / customer)を `secureFetch` に渡せるようにし(オプション引数)、confidential 文脈からの送信は「宛先が当該テナントの許可ドメイン(tenant override の egress 設定)か」を検査。非該当は承認要求。
2. パターンベース redaction(`:68-95`)に加え、confidential ペイロードの送信時は「機密データを外部送信しようとしています」の明示警告を operator に出す(分類ベースの完全 DLP は目指さない — 現実的な注意喚起 + tier ドメイン照合まで)。
3. test: confidential 文脈 × 非許可ドメイン → ブロック/承認。

### Task 3: SSRF 強化 — `claude-sonnet-4`

1. `validateUrl` にホスト名の DNS 解決 → 解決 IP の private/loopback 再検査を追加(リバインディング対策)。解決結果を短時間キャッシュし、実 fetch は同じ解決 IP をピン留めできるか検討(できなければ再検査のみ)。
2. `KYBERION_ALLOW_LOCAL_NETWORK`(`:469`)を「開発モードのみ有効 + 有効時は毎回 logger.warn」に限定する。
3. test: リバインディング的ケース(ホスト名は公開・解決先 private)のブロック。

### Task 4: egress 監査 — `claude-haiku`

- 全 `secureFetch` の結果(宛先ホスト・メソッド・サイズ・tier・allowlist 判定・承認有無)を監査チェーン(SA-01)へ記録。AA-05 の `mission flow` に egress 行を含める。

## リスクと注意

- allowlist 全適用は**外部連携を広範に止め得る**。Task 1 の自動収集(service preset 由来)で既存の正当な送信先を確実にカバーしてから enforce にする。warn 期間中の非該当ホスト一覧を棚卸しして allowlist を育てる。
- 分類ベース DLP(業務機密の内容判定)は本計画のスコープ外(誤検知と運用コストが大きい)。ここでは「tier ドメイン照合 + 送信時警告 + 監査」までとし、内容分類は将来計画として本文書に「次の一手」で記す。
- redaction はログ/監査への混入防止であって漏洩防止の主機構ではない。egress ブロックが主、redaction は従、という位置づけを文書化する。
