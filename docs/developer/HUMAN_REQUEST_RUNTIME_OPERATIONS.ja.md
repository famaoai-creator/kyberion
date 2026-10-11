# Web / HTTP MCP の共通依頼ランタイム

## 初期状態と境界

この実装は初期状態で無効。認証基盤、クライアント、秘密情報、メンバーの外部 ID、
TLS 終端、プロキシ、公開ポートを登録・変更しない。既存の OIDC ログイン画面と stdio
MCP はそのまま利用する。以下は将来の明示的な設定に使うコードの操作説明であり、
実環境での有効化や接続確認が済んだという意味ではない。

共通設定はサーバー所有の JSON ファイルを明示する。Web は
KYBERION_HUMAN_REQUEST_CONFIG、HTTP エントリポイントは同じ変数、または
明示的な --config によるパスを使う。リクエスト入力から設定を受け取らない。
変数が未設定なら両方無効。設定されたファイルが不在・読めない・不正な場合は
無効扱いに戻さず拒否する。読み取りは既存の secure-io 権限に従う。
設定ファイルにトークン、秘密鍵、クライアントシークレットを入れない。

最小の無効設定:

```json
{ "version": 1, "browser": { "enabled": false }, "httpMcp": { "enabled": false } }
```

## 明示する項目

- policy: authorityNamespace、tenantSlugs、organizationIds、projectIds、tierAccess。
  authorityNamespace は同じメンバー台帳を利用する導入単位で安定させる。
  tierAccess は public / confidential のみ。テナントの all や personal は受け付けない。
- browser.enabled: 真偽値。true の場合は policy と operationScopes が必須。
  operationScopes は kyberion:requests:read / kyberion:requests:receive の明示許可。
  openid / profile / email やログイン時のスコープを転用しない。
- httpMcp.enabled: 真偽値。true の場合は policy と token が必須。
- httpMcp.token: issuer、resource、algorithms、jwks.keys。
  issuer と resource は完全な HTTPS URL。resource はルート以外の専用パス。
  algorithms は RS256 / ES256、鍵は事前固定の公開 JWK のみ。
  既存 Web の client_id、audience、JWKS や Cookie を自動利用しない。
- httpMcp.allowedOrigins: 完全一致する HTTPS origin の配列。resource 自身の origin は
  既存ルーターが許可する。Origin の許可は認証や操作権限を付与しない。
- httpMcp.deployment: start 時だけ必須。
  mode は loopback-reverse-proxy、host は 127.0.0.1 または ::1、port は明示した
  1〜65535 の整数。localhost、0.0.0.0、::、暗黙のポートは受け付けない。

未知のフィールド、文字列の true、欠けた必須項目、秘密 JWK フィールドは拒否する。
無効なセクションでも指定された値は検証する。鍵とアルゴリズムの実際の組み合わせは
HTTP ランタイムの構成時に追加検証する。動的 JWKS 更新、opaque token introspection、
認可サーバー機能はこのプロファイルに含まない。

## 検証と起動は別操作

ビルド後の専用コマンドとエントリポイント:

```sh
pnpm kyberion mcp http --check --config <reviewed-server-config.json>
pnpm kyberion mcp http --start --config <reviewed-server-config.json>
# 同じ専用エントリポイントを直接実行する場合
node dist/scripts/mcp_http_server.js --check --config <reviewed-server-config.json>
```

--check / --dry-run はポートを開かない。--start と同時指定しても検証が優先する。
検証結果の listening は false。暗号設定をローカル検証しても
external_tls_verified / provider_verified は false のまま。
--start は明示的な有効設定と deployment がない限り失敗する。インポートだけでは
起動しない。SIGINT / SIGTERM で閉じ、bind 失敗は非秘密のエラーを返す。
既存の pnpm mcp:server は引き続き stdio 専用。

このコードが提供する起動プロファイルは、別管理の HTTPS リバースプロキシの
背後にあるループバック HTTP 接続のみ。実際にこの構成を使うかは別途決定する。
プロキシは resource の Host を維持し、外部 HTTP を HTTPS へ安全に終端する必要がある。
アプリは trust proxy を有効化せず、Forwarded / X-Forwarded-* を本人確認や許可に使わない。
Host / Origin 検査は HTTPS の実在を証明しない。起動前に運用者が TLS 証明書、
公開経路、プロキシ経路、ローカルプロセスのアクセス境界を別途確認する。
プロキシ設定・証明書登録・公開 listener の起動は行わない。

ルーターは Express アプリのルートへ mount する。MCP resource と SDK が算出した
/.well-known/oauth-protected-resource/... の両方をそのまま到達させる。
独自の /mcp prefix で二重 mount しない。無効時にはどちらの route も存在しない。

## Web の本人確認と依頼権限

署名済みブラウザーセッションを検証した provider だけが、元の issuer / subject /
期限をプロセス内部の WeakMap に保持する。シリアライズ、principal の複製、
principalId、メール、リクエストの自己申告からこの証拠を作れない。
/api/message の GET / POST だけが、明示的な browser 有効化時に証拠を利用する。

毎回、現在の外部 ID binding と active member、テナント role を厳密に確認し、
サーバー policy と最後に絞られた viewer 権限の積集合にする。
同じ subject が複数メンバーへ結び付く場合や台帳を確認できない場合は拒否する。
受信には選択したテナントの owner / operator と receive 許可、読取には read 許可が必要。
canonical viewer は readonly のままで、管理者権限や personal tier を与えない。
認証済みブラウザー経路で失敗しても旧形式の本人へ戻さない。

明示的な Authorization が Cookie より優先し、不正な明示ヘッダーを Cookie へ
格下げしない。Cookie を使う POST の same-origin / CSRF 検査とレート制限を維持する。
他の設定、承認、メンバー管理などの mutation guard は変更しない。
依頼受信・結果・履歴は本人に基づく監査記録に成功してから処理する。
監査障害や設定障害の詳細をブラウザーへ返さない。

## 履歴、再試行、残る確認

Web と MCP が同じ authorityNamespace、登録済みメンバー、最終的な tenant / organization /
project / tier 制限を持つ場合だけ、同じ依頼 ID と結果を共有する。
MCP が tier を狭めるなど実効制限が違う場合、別の所有区画になる。
別 issuer や pairwise subject を同じ本人と見なすには、運用者による明示 binding が必要。
メール一致で自動統合しない。旧履歴は移行しない。

重複送信は既存の共通依頼サービスの予約・保存結果を使い、実行不明の再送は自動実行しない。
replyStatus が answered でも委任作業の完了とは限らない。
ローカル診断の localadmin mapping、passkey / A3 承認の上流条件は変更しない。

テストは合成 Cookie、合成 RSA access token、合成 registry と一時 localhost listener を使う。
実 IdP、実ブラウザー認証の相互運用、外部 TLS、プロキシ運用、一般的な全 OAuth provider
への対応は未確認。SDK 1.31.0 / protocol 2025-11-25 と、設計に参照した
2026-07-28 authorization guidance を区別する。
