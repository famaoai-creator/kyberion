# AC-05: 外部サービス認証の成熟化と日本企業向け接続の第一歩

> 優先度: P2 / 規模: M / 依存: なし / 関連: AC-01、[COWORK_INTEGRATION_PLAN](../../COWORK_INTEGRATION_PLAN.md)

## 背景と課題

サービス実行エンジン(`libs/core/service-engine*.ts`)は api/cli/mcp(stdio・HTTP)の4トランスポートを持つ本格実装で、OAuth 基盤(`oauth-broker.ts` の PKCE 込み full flow + `scripts/oauth_callback_surface.ts` のコールバックサーバ)も production 級。しかし:

- **OAuth を実際に使うプリセットは 32 中 2 つだけ**(canva, xapi)。github/slack/notion/jira 等の主要どころは**手動トークン貼付**で、失効・ローテーションの運用が脆い。
- **トークンは平文 JSON で保存**(`libs/core/secret-guard.ts` → `vault/secrets/`・`knowledge/personal/connections/`。fsync/backup/監査はあるが暗号化なし)。外部 KMS リゾルバはコメント上のフックのみ。
- **日本企業向け SaaS の API 連携がゼロ**: LINE WORKS / Teams(チャット) / kintone / freee / Box / Chatwork 等は preset が無く、USE_CASES に登場する freee 等は**ブラウザ自動化(procedure registry)だけが経路**(`libs/core/procedure-registry.test.ts` の `attendance.approve.freee`)。`service-binding.test.ts` は `kintone:approval` バインディングを参照するが kintone preset は存在しない。
- SBI グループ運用(6 テナント)では kintone / LINE WORKS 系の需要が現実的に見込まれる。

## スコープの限定(重要)

ロードマップ非目標(製品としての OAuth/SSO・SaaS 化)には踏み込まない。ここでの認証成熟化は「**外部サービスへの接続資格情報の管理品質**」であり、対象は (1) 既存 OAuth 基盤の活用拡大、(2) 保存時保護、(3) API トークン方式で完結する日本 SaaS プリセット 2 件のパイロットに限る。LINE WORKS ブリッジ(メッセージングチャネル化)は**調査タスクのみ**とし、実装判断は結果を見て別途行う。

## ゴール(受入条件)

1. OAuth プロファイルが github / slack / notion のうち**リフレッシュ運用の効果が大きい 1〜2 サービス**に追加され、`begin → callback → exchange → refresh` が E2E で動く。
2. `vault/secrets/` の保存時暗号化オプションが入る(macOS Keychain または age/libsodium 系。env でオプトイン、既存平文との互換読込あり)。
3. kintone preset(API トークン認証)が追加され、レコード取得/追加/更新 + 承認プロセス進行の基本 op が動く(`kintone:approval` バインディングの実体化)。
4. トークン失効時のエラーが「再認証手順つき」の分類エラーになる(AC-01 形式)。

## 実装タスク

### Task 1: OAuth プロファイル拡大 — `claude-sonnet-4`

1. `canva.json` の oauth プロファイル(`authorize_url`/`exchange_oauth_code`/`refresh_oauth_token`)を雛形に、対象サービス(推奨: notion または slack — GitHub PAT 運用は安定しているので後回し可)のプロファイルを preset に追加する。
2. `oauth_callback_surface.ts` を使った E2E 手順を `docs/developer/LOCAL_DEV.md` に記載し、サンドボックスアプリでの疎通を確認する(実アプリ登録が必要な部分は手順書化まで。市村さんのアプリ登録が必要な旨を報告)。
3. `refresh_oauth_token` の自動リフレッシュ(実行時に expires_at 超過を検知して refresh してからリトライ)を `service-engine-execution.ts` の auth 解決に追加し、unit test を付ける。

### 実装状況 (2026-07-11 — Task 2)

- `libs/core/secret-encryption.ts`: `KYBERION_SECRET_ENCRYPTION=none|keychain`(既定 none=現行互換、未知値は fail-closed で throw)。keychain モードは macOS `security` CLI(secure-io の safeExecResult 経由)に保持した 32 バイト鍵で AES-256-GCM。読込は自動判別(平文互換)、暗号化済み文書の復号失敗は loud に throw(起動スキャンのみ warn+skip)。バックアップは raw バイト(暗号文書に平文 .bak を作らない)。
- `pnpm secrets:encrypt`(`--decrypt` で平文エクスポート=鍵全損時の脱出経路)。migrate は各ファイルの raw .bak を先に書く。
- テスト: モード解決(未知値拒否)、roundtrip、改竄/鍵違い拒否、migrate の encrypt→skip 冪等→decrypt 復元(計21件緑、鍵はテスト注入で keychain 非接触)。
- 残: age モード(非 Mac)、OAuth プリセット拡大(Task 1/3)、kintone(Task 4)。

### Task 2: 保存時暗号化オプション — `claude-sonnet-4`

1. `secret-guard.ts` の `storeConnectionDocument`/`loadConnectionDocument` に暗号化層を追加: `KYBERION_SECRET_ENCRYPTION=keychain|age|none`(既定 none=現行互換)。keychain は macOS `security` CLI、age は Node 実装(依存追加は 1 パッケージまで)。
2. 平文既存ファイルは読める(読込時に自動判別)。`migrate` コマンド(`pnpm secrets:encrypt`)で一括暗号化。
3. 監査ledger(CONFIG_CHANGE)は維持。テスト: encrypt→load 往復、平文互換、誤鍵時の分類エラー。

### Task 3: kintone preset パイロット — `claude-sonnet-4`

1. `knowledge/product/orchestration/service-presets/kintone.json` を新設: `auth_strategy: api_key_query` 相当ではなく kintone の `X-Cybozu-API-Token` ヘッダ方式(既存 `buildAuthHeaders` の拡張が要るか確認)。op: `record_get` / `records_list` / `record_add` / `record_update` / `status_update`(承認プロセス進行)。
2. `service-endpoints/` にエンドポイント定義を追加し、`sync:service-endpoints` とスキーマ検証を通す。
3. `service-binding.test.ts` が参照する `kintone:approval` バインディングを実 preset に接続し、モックサーバでの契約テストを追加。
4. USE_CASES の該当行(kintone 系)に「API 経路あり」を追記。

### Task 4: LINE WORKS 接続の調査(実装しない)— `claude-sonnet-4`

- LINE WORKS Bot API の認証方式(Service Account + JWT)・メッセージ送受信 API・監査要件を調査し、「satellites ブリッジとして実装する場合の設計メモ(工数・リスク・既存 bridge との共通化)」を 1 ページで本文書末尾に追記する。**実装判断は市村さんに委ねる**。

### Task 5: 失効エラーの分類 — `claude-haiku`

- `service-engine-execution.ts` の HTTP 401/403 応答を「認証失効。<service> の再認証手順: …」の分類エラーに変換する(サービスごとの手順文言は preset に `reauth_hint` フィールドを追加して持たせる)。代表 2 サービスでテスト。

## リスクと注意

- kintone はテナント URL(`https://<subdomain>.cybozu.com`)がユーザー固有。preset の `base_url` はプレースホルダにし、接続ドキュメント側で解決する既存パターン(他 preset の `{{env.*}}`/binding 方式)に従う。
- 暗号化オプションは**鍵を失うと接続情報が全損**する。migrate 前のバックアップと、`none` への復号エクスポート手段を必ず用意する。
- confidential tier の顧客接続情報には触れない(テストはダミー値のみ)。
