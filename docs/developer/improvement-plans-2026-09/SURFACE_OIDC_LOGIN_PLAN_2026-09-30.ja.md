---
title: サーフェスの OIDC ログイン — 未認証ブラウザを生の 401 で止めない
category: Improvement Plan
tags: [surfaces, authentication, oidc, sso, google, entra, rbac, multi-tenant]
last_updated: 2026-09-30
status: completed
---

# サーフェスの OIDC ログイン

## 判断

リモートのブラウザが認証なしでサーフェスを開くと、ページの殻だけが表示され、最初の API 呼び出しが生の `{"error":"Unauthorized."}` で終わっていた。ブラウザは Bearer ヘッダーを付けられず、`kyberion_token` cookie を発行するコードも無かったため、正規の利用者が認証する手段が無かった。`operator-surface` に至っては認証が一切なく、全インターフェースに bind していた。

標準の OIDC(Authorization Code + PKCE)によるブラウザログインを、5 つの UI サーフェスすべてに共通実装 1 つで提供する。認可は従来どおり member registry と tenant scope が決める。ログインは「本人確認」だけを足す。

## 既存資産との関係

- JWT の検証と `iss`+`sub` → member の紐付け(`external_identities`)は `oidc-jwt` provider に既にあった。足りなかったのはブラウザ向けの code flow、セッション、画面、各面への組み込み。
- 認可経路(`resolveAuthnSurfaceViewerScope` → `ViewerContext` → 操作の `required_permissions`)は変えない。

## 設計

| 論点                     | 決定                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IdP                      | 汎用 OIDC(discovery)。Google と Microsoft Entra を実物の discovery で確認。Entra は `/common` の issuer がテンプレートのため、テナント固有 issuer を要求 |
| セッション               | 署名付き(HMAC-SHA256)の無状態 cookie `kyberion_session`(`kys1.`)。`iss`/`sub`/期限のみ。**権限は入れない**                                               |
| 認可の鮮度               | `browser-session` provider がリクエストごとに member registry から principal を再導出。停止・`memberships` 変更が即時に効く                              |
| 未紐付け IdP アカウント  | **セッションを発行しない**。Google のような公開 IdP では「認証できた」が「誰でも」を意味するため。画面に `issuer`/`subject` を出し、管理者が紐付ける     |
| 紐付けの経路             | concierge の member PATCH に `external_identity(_remove)` を追加(全所属 tenant で owner を要求、重複は 409)。設定画面から操作                            |
| loopback                 | **変更なし**(`KYBERION_LOCALHOST_AUTOADMIN`)。ログインはリモートと `AUTOADMIN=false` のときだけ                                                          |
| 未認証の扱い             | ページ遷移のみ `302 /login`。API は 401 JSON のまま。判定は `Sec-Fetch-Mode: navigate`(フォールバックは `Accept`)                                        |
| CSRF                     | `SameSite=Lax` + cookie 認証の変更系は `Origin`/`Referer` のホスト一致を要求。ヘッダー認証は対象外                                                       |
| リダイレクト URI         | 非 loopback は公開 origin の宣言が必須(`KYBERION_OIDC_PUBLIC_BASE_URL(S)`)。Host ヘッダーは信用しない。サーフェスごとの origin を指定可                  |
| 通信                     | `secureFetch`(egress policy と監査)経由。トークン交換は `authenticateRequest: true`(code/verifier/secret の墨消し回避)                                   |
| 画面                     | サーバー描画の JS なし HTML(CSP `default-src 'none'`)、light/dark、en/ja。全面で 1 実装                                                                  |
| concierge の既存トークン | `/signin` のトークン入力は存続。`kyberion_client_token` ヒント cookie でページ遷移を通す(UX のみ。API は実トークンを検証)                                |

## 実装

- `libs/core/authn-providers.ts` — `browser-session` provider、`mintBrowserSessionToken` / `verifyBrowserSessionToken`。`oidc-jwt` は `kys1.` を JWT と誤認しないよう除外(最初のハード拒否が勝つ仕様のため)
- `libs/core/surface/oidc-browser-login.ts` — discovery/JWKS(キャッシュ、鍵ローテーション時は 1 回だけ再取得)、state/nonce/PKCE、コード交換、id_token 検証(署名・iss・aud・azp・exp・nbf・nonce)、member 束縛確認、監査(`surface_login`)
- `libs/core/surface/surface-auth-routes.ts` — 全面共通の `/login` `/auth/start` `/auth/callback` `/logout`
- `libs/core/surface/surface-session-cookie.ts` — edge-safe な cookie・ナビゲーション判定・`next` の無害化・same-origin 検査
- `libs/core/surface/surface-login-pages.ts` — ログイン画面
- 各サーフェスに middleware / 薄いアダプタ(chronos・concierge・operator は Next の route handler、presence-studio・computer-surface は Express)

運用手順: [SURFACE_OIDC_LOGIN_OPERATIONS](../SURFACE_OIDC_LOGIN_OPERATIONS.ja.md)。

## スコープ外(意図的)

- IdP 側の `end_session`(RP-initiated logout)、リフレッシュトークン、グループ claim からの member 自動作成(JIT プロビジョニング)
- 発行済み cookie の個別失効(無状態のため)。対処は member 停止、または `KYBERION_SESSION_SECRET` の入れ替え
- 複数テナント共用の Entra `/common`
- `scripts/personal-pads` などの loopback 限定サーバー(既存のローカルトークンのまま)

## 運用上の判断(解決済み)

- **egress policy**: Google(`accounts.google.com` `oauth2.googleapis.com` `www.googleapis.com`)と Microsoft(`login.microsoftonline.com`)のホストを `manual_allowed_domains` に追加した。別の IdP を使う場合は同じ一覧に追加する。
- **ローカル利用**: Next.js 系の 3 面は同じマシンのブラウザを loopback と判定できない(従来どおり)。トークン入力の入口は設けず、**IdP でのサインインをローカルでも使える**ようにした(`localhost` 系の origin に限り、Host から戻り先を決める)。5 面すべてを、モック IdP で実機検証済み。
