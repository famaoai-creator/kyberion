---
title: サーフェス OIDC ログイン 運用手順
tags: [surfaces, authentication, oidc, sso, google, entra, multi-tenant]
last_updated: 2026-10-09
---

# サーフェス OIDC ログイン 運用手順

リモート(非 loopback)のブラウザから 5 つの UI サーフェスを使うための、標準 OIDC(Authorization Code + PKCE)ログインです。未認証のブラウザが生の `{"error":"Unauthorized."}` を見て止まる代わりに、共通のログイン画面へ誘導されます。

> この機構は OSS / self-hosted の内部認可です。hosted account management や SaaS のユーザー管理ではありません。認可(誰が何を見られるか)は従来どおり member registry と tenant scope が決めます。ログインは「本人確認」だけを足します。

## 何が変わるか

| 状況                                                            | 動作                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| loopback(`127.0.0.1` / `::1`)                                   | **変わらない**。`KYBERION_LOCALHOST_AUTOADMIN` の自動 admin のままで、ログイン不要          |
| リモート + 未認証のブラウザ(ページ遷移)                         | `302 /login?next=…`。SSO が設定済みならボタン、未設定なら設定手順の説明画面                 |
| リモート + 未認証の API 呼び出し(fetch / curl / `Accept: json`) | **従来どおり 401 JSON**                                                                     |
| Bearer トークン(`KYBERION_API_TOKEN`、registry token、JWT)      | **従来どおり**。ヘッダーがセッション cookie より優先                                        |
| SSO でサインインできたが member に紐付いていない                | セッションを発行しない。画面に IdP の `issuer` / `subject` を表示し、管理者に紐付けてもらう |
| member が停止された                                             | 次のリクエストから拒否(cookie は無状態だが、リクエストごとに member registry を引き直す)    |

> **注意(Next.js 系の 3 面)**: Next.js 15 以降は `NextRequest.ip` が無く、`KYBERION_TRUST_PROXY=1`(`x-real-ip` / `x-forwarded-for` を必ず上書きする信頼できるプロキシの背後)でない限り、同じマシンのブラウザでも loopback と判定されません(従来からの仕様。CHANGELOG 参照)。その場合、ローカルでもログイン画面(またはアクセストークン)が必要です。`KYBERION_TRUST_PROXY=1` をプロキシ無しで有効にすると `X-Forwarded-For: 127.0.0.1` の偽装で loopback になりすませるため、プロキシ無しでは有効にしないでください。Express 系の 2 面(presence-studio / computer-surface)はソケットの接続元で判定するため影響を受けません。

> **レート制限と `/logout`**: Next.js 系の 3 面は `/login` と `/auth/*` をクライアント毎 120 回/分・面全体 600 回/分で制限します(超過は 429 + `Retry-After`)。クライアントを区別できる接続元 IP は `KYBERION_TRUST_PROXY=1` のとき(または Express 系の 2 面)だけ得られます。それが無いと全員が同一の `shared` とみなされ、**面全体の上限(600 回/分)だけ**が適用されます(1 人の連打で全員が締め出されないため)。loopback は制限対象外です。`/logout` は `Sec-Fetch-Site` が `same-origin` / `none` のときだけセッションを破棄します(`cross-site` と `same-site`=兄弟サブドメインは無視)。ヘッダが無い古いブラウザでは `Origin` / `Referer` が自分以外のホストなら無視します。無視した場合は 403 で「他のサイトからのサインアウト要求は無視しました」と表示します(サインイン状態は維持されます)。

### ローカルでも IdP でサインインする

Next.js 系の 3 面は同じマシンのブラウザを loopback と判定できませんが、**IdP でサインインすればローカルでも使えます**(新しいトークン入力の入口は追加していません。concierge の従来の `/signin` はそのまま使えます)。

1. IdP のクライアントに、使うサーフェスのリダイレクト URI `http://localhost:<port>/auth/callback` を登録します(ポートは下の表。Google は `127.0.0.1` の IP 表記を受け付けないので `localhost`)。
2. `KYBERION_OIDC_ISSUER` / `KYBERION_OIDC_CLIENT_ID` / `KYBERION_OIDC_CLIENT_SECRET` / `KYBERION_SESSION_SECRET` を設定して起動します。`KYBERION_OIDC_PUBLIC_BASE_URL` は不要です。
3. ブラウザで `http://localhost:<port>/` を開くと `/login` に誘導され、ボタンから IdP へ進めます。自分の `issuer` / `subject` が member に紐付いている必要があります(初回は未登録画面に表示される値を、別の owner に紐付けてもらいます)。

`localhost` 系の origin に限って Host から戻り先を決めるのは、IdP がブラウザを利用者自身のマシンへ戻すだけで、外部ホストへのリダイレクトにできないためです。`localhost.evil.example` のような名前は対象外です。

対象サーフェス: `concierge` / `chronos-mirror-v2` / `operator-surface` / `presence-studio` / `computer-surface`(ログイン処理は `libs/core/surface/surface-auth-routes.ts` の 1 実装を共有)。

## 仕組み

```
browser ──GET /login──▶ surface           SSO 設定済みならサインインボタン
browser ──GET /auth/start──▶ surface ──302──▶ IdP   state + nonce + PKCE(S256)。秘密は署名済み HttpOnly の一時 cookie にだけ置く
IdP ──302 /auth/callback?code&state──▶ surface
surface ──POST token endpoint──▶ IdP     code + code_verifier (+ client_secret)
surface: id_token を JWKS で検証(iss / aud=client_id / azp / exp / nbf / nonce)
surface: iss+sub が「active な member」に紐付いているか確認
surface ──Set-Cookie: kyberion_session=kys1.…──▶ browser   (HttpOnly; SameSite=Lax; https なら Secure)
```

- セッションは署名付き(HMAC-SHA256)の無状態 cookie です。中身は `iss` / `sub` / 期限だけで、**権限は入れません**。リクエストごとに `browser-session` authn provider が member registry から principal を再導出します(`memberships` の変更・停止が即時に効く)。
- **未紐付けの IdP アカウントにはセッションを発行しません。** Google のように誰でもアカウントを持てる IdP では、「認証できた」が「誰でも」を意味してしまうためです。
- id_token は保存しません。リフレッシュトークンも扱いません。セッション期限(既定 8 時間)が来たら再ログインします。
- cookie 認証の変更系リクエスト(POST/PUT/PATCH/DELETE)は、`Origin`(または `Referer`)のホストが自分のホストと一致しなければ 403 です(CSRF 対策)。ヘッダー認証にはこの検査はかかりません。
- ログアウト(`/logout`)は cookie を消します。無状態のため、盗まれた cookie を期限前に失効させる仕組みはありません。その場合は member を停止するか `KYBERION_SESSION_SECRET` を入れ替えてください(全セッションが無効になります)。

## 初回セットアップ(画面から設定する)

ブラウザからサインインできる owner がまだ居ない環境では、concierge の画面で owner の作成・アクセストークンの発行・SSO 設定までを済ませられます。環境変数の編集とサーフェスの再起動は要りません。

```bash
# ホストで実行(一回限りのセットアップコードと URL が表示される)
pnpm organization first-run code            # --ttl-minutes 30 --url http://localhost:3050
pnpm organization first-run status          # まだ開いているか
```

1. 表示された `http://localhost:3050/setup/first-run#code=…` を開き、組織 ID・組織名・自分の表示名を入れて「セットアップする」。
2. owner に紐付くアクセストークンが**一度だけ**表示されます。このタブはそのトークンでサインイン済みになります。他のサーフェスでは `/signin` や Bearer ヘッダーで使います。
3. 続けて SSO の issuer / client id / client secret を保存します。画面に出るリダイレクト URI を IdP に登録します。
4. 「自分のアカウントを紐付ける」を押して IdP でサインインすると、その IdP アカウントが自分(owner)に紐付きます。以後は全サーフェスの `/login` から IdP でサインインできます。トークンは画面を離れる前に控えてください。

- コードは SHA-256 ハッシュだけを secret-guard(`kyberion-first-run`)に保存します。既定 30 分、失敗 5 回で失効、使用で失効します。再発行すると前のコードは無効になります。
- URL のコードは fragment(`#code=`)に置くので、サーバーやプロキシのログには残りません。
- 一度 claim すると永久に閉じます。owner がトークンか IdP 紐付けを既に持つ環境では最初から閉じています。
- claim API は自ホストの Origin からの要求だけを受け付け、クライアントあたり 10 回/分に制限します。

### 画面から保存した SSO 設定

`/setup/sso`(設定 › 組織とメンバー › SSO 欄のリンク)で後から変更できます。変更できるのは**登録済みの全 tenant で owner** の member だけです(インスタンス全体の設定のため)。

- 保存先は secret-guard の `kyberion-oidc`。client secret は応答に含めず、空欄で保存すると既存の値を維持します。
- セッション署名鍵が無ければ `kyberion-browser-session` に自動生成します。`KYBERION_SESSION_SECRET` が 32 バイト未満で設定されている場合は自動生成せず警告します(環境変数の鍵が優先されるため)。
- `KYBERION_OIDC_ISSUER` か `KYBERION_OIDC_CLIENT_ID` が環境変数にあると、環境変数**一式**が使われ、画面の設定は無視されます(混在させません)。
- 保存は監査ログ(`surface_sso_settings`)と secret-guard の `CONFIG_CHANGE` に残ります。

## 設定

環境変数(`knowledge/product/governance/env-registry.json` に登録済み)で与える場合は、**全サーフェス(プロセス/ホスト)で同じ値**にします。画面から保存する場合は上の「初回セットアップ」を参照してください。

| 変数                             | 必須       | 内容                                                                                                                                                                                                                                |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KYBERION_OIDC_ISSUER`           | ✅         | IdP の issuer。discovery(`<issuer>/.well-known/openid-configuration`)の `issuer` と完全一致が必要                                                                                                                                   |
| `KYBERION_OIDC_CLIENT_ID`        | ✅         | OAuth クライアント ID                                                                                                                                                                                                               |
| `KYBERION_OIDC_CLIENT_SECRET`    | IdP による | Google / Entra の Web クライアントは必須。secret store に置く                                                                                                                                                                       |
| `KYBERION_SESSION_SECRET`        | ✅         | セッション cookie の署名鍵(**32 バイト以上**のランダム値。短い値は「未設定」扱い)。secret store に置く                                                                                                                              |
| `KYBERION_OIDC_PUBLIC_BASE_URL`  | リモートで | サーフェスの公開 origin(`https://…`)。リダイレクト URI は `<origin>/auth/callback`。Host ヘッダーは信用しません。`localhost` / `127.0.0.1` / `[::1]` の origin からのアクセスは、これが無くてもその origin を使います(ローカル利用) |
| `KYBERION_OIDC_PUBLIC_BASE_URLS` | 任意       | サーフェスごとの公開 origin。`concierge=https://desk.example.com,chronos-mirror-v2=https://ops.example.com` のように指定                                                                                                            |
| `KYBERION_OIDC_SCOPES`           | 任意       | 既定 `openid`。`email` などが要るならここに追加(member の紐付けは `iss`+`sub` なので不要)                                                                                                                                           |
| `KYBERION_OIDC_PROVIDER_LABEL`   | 任意       | ボタン表示名(例 `Google` / `Microsoft`)。既定 `SSO`                                                                                                                                                                                 |
| `KYBERION_SESSION_TTL_SECONDS`   | 任意       | セッション寿命。既定 28800(8 時間)、最小 60                                                                                                                                                                                         |

サーフェスごとの既定ポートと、IdP に登録するリダイレクト URI(公開 origin を使う場合はそれに読み替え):

| サーフェス        | サーフェス ID       | ポート | リダイレクト URI(ローカル検証用)      |
| ----------------- | ------------------- | ------ | ------------------------------------- |
| concierge         | `concierge`         | 3050   | `http://localhost:3050/auth/callback` |
| chronos-mirror-v2 | `chronos-mirror-v2` | 3000   | `http://localhost:3000/auth/callback` |
| presence-studio   | `presence-studio`   | 3031   | `http://localhost:3031/auth/callback` |
| computer-surface  | `computer-surface`  | 3040   | `http://localhost:3040/auth/callback` |
| operator-surface  | `operator-surface`  | 3331   | `http://localhost:3331/auth/callback` |

IdP への通信は `secureFetch`(egress policy と監査)を通ります。Google(`accounts.google.com` / `oauth2.googleapis.com` / `www.googleapis.com`)と Microsoft(`login.microsoftonline.com`)のホストは、`knowledge/product/governance/egress-policy.json` の `manual_allowed_domains` に**既定で登録済み**です。別の IdP(Keycloak、Okta など)を使う場合は、そのホストを同じ一覧に追加してください(`mode: enforce` ではこれが無いとログインできません)。

## ローカル検証用の開発 IdP

Google / Entra のクライアントを作らずに、ローカルで `/login` を試すための使い捨て IdP です(`scripts/dev_oidc_idp.ts`)。誰が来ても固定の subject(既定 `dev-user`)としてサインインさせるため、**`127.0.0.1` にしかバインドせず**、リダイレクト先も `http://localhost:<port>/auth/callback` に限定し、`NODE_ENV=production` では起動しません。検証専用で、リモート公開には使えません。

```bash
# 1. 開発 IdP を起動(別ターミナルで起動したままにする)
node --import ./scripts/ts-loader.mjs scripts/dev_oidc_idp.ts
#   --port 9099  --client-id kyberion-dev  --subject dev-user  --email <任意>

# 2. 表示された export を、サーフェスを起動するシェルに貼り付けて起動
export KYBERION_OIDC_ISSUER=http://localhost:9099
export KYBERION_OIDC_CLIENT_ID=kyberion-dev
export KYBERION_OIDC_PROVIDER_LABEL='Dev IdP'
export KYBERION_SESSION_SECRET=<表示された値>

# 3. この subject を自分の member に紐付ける(初回のみ)
pnpm organization member link-identity <member-id> --issuer http://localhost:9099 --subject dev-user
```

`http://localhost:<サーフェスのポート>/` を開くと `/login` に誘導され、ボタンから開発 IdP の確認画面 → サインインできます。`KYBERION_SESSION_SECRET` は全サーフェスで同じ値にしてください(`KYBERION_SESSION_SECRET` を先に設定して起動すれば、その値が使われます)。紐付けていない場合は「このアカウントは登録されていません」になります(fail-closed は本番と同じ)。

## Google

1. [Google Cloud Console](https://console.cloud.google.com/) → API とサービス → 認証情報 → **OAuth クライアント ID**(種類: ウェブ アプリケーション)。
2. 承認済みのリダイレクト URI に、使うサーフェスの `https://<公開 origin>/auth/callback` を登録(ローカル検証は `http://localhost:<port>/auth/callback`。Google の Web クライアントは `127.0.0.1` の IP 表記を受け付けません。loopback は自動 admin なので、ローカルで SSO を試す必要があるのは検証時だけです)。
3. 環境変数:

```bash
export KYBERION_OIDC_ISSUER=https://accounts.google.com
export KYBERION_OIDC_CLIENT_ID=<client id>.apps.googleusercontent.com
export KYBERION_OIDC_CLIENT_SECRET=<client secret>        # secret store 推奨
export KYBERION_OIDC_PROVIDER_LABEL=Google
```

- Google の id_token は `iss` が `accounts.google.com`(スキームなし)で届くことがあります。これは同一 issuer として受理し、member の紐付けは設定した issuer(`https://accounts.google.com`)で行います。
- `sub` は Google アカウントごとに固定の数値文字列です(メールアドレスではありません)。

## Microsoft Entra ID(Azure AD)

1. Entra 管理センター → アプリの登録 → 新規登録。**サポートされるアカウントの種類は「この組織ディレクトリのみ(シングルテナント)」**。リダイレクト URI は種類「Web」で `https://<公開 origin>/auth/callback`。
2. 証明書とシークレット → 新しいクライアント シークレット。
3. 環境変数(`<tenant-id>` は「ディレクトリ(テナント) ID」):

```bash
export KYBERION_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
export KYBERION_OIDC_CLIENT_ID=<application (client) id>
export KYBERION_OIDC_CLIENT_SECRET=<secret value>         # secret store 推奨
export KYBERION_OIDC_PROVIDER_LABEL=Microsoft
```

- **`/common` / `/organizations` は使えません。** これらの discovery は issuer が `https://login.microsoftonline.com/{tenantid}/v2.0` というテンプレートを返し、設定値と一致しないためログイン開始時に拒否されます(監査ログに理由が残ります)。テナント固有の issuer を指定してください。
- Entra の `sub` は**アプリごとのペアワイズ識別子**です。別アプリの `sub` とは一致しません。必ず、このアプリでサインインして表示された値で紐付けてください。

## member の紐付け

1. owner が concierge の「設定 › 組織とメンバー」で、対象 member の「SSO」欄に `issuer`(`KYBERION_OIDC_ISSUER` と同じ値)と `subject`(`sub`)を入力して紐付けます。API は `PATCH /api/members/<member_id>` の `external_identity`(紐付け)/ `external_identity_remove`(解除)です。紐付けはその member の**全 tenant の権限**をそのアカウントに与える操作なので、member が所属するすべての tenant で owner であることが必要です。1 組の `issuer`+`subject` は 1 人の member にしか紐付けられません(重複は 409)。
2. 利用者が先にサインインを試すと、未登録画面に `issuer` / `subject` が表示されます。これを管理者に伝えれば、そのまま貼り付けて紐付けられます。
3. **自分で紐付ける**: トークン(`/signin`)などで concierge にサインイン済みの member は、`/setup/sso` の「自分のアカウントを紐付ける」から IdP でサインインすると、そのアカウントを自分に紐付けられます(`POST /api/setup/link-identity`)。紐付け先の member はサインイン中の viewer からサーバー側で決まり、HMAC 署名付きのログイン transaction cookie(10 分)にだけ入ります。callback では、未紐付けのアカウントだけを紐付けます。別の member に紐付いたアカウントは拒否し(「紐付けできませんでした」)、その member としてサインインさせることもしません。停止中の member にも紐付けません。監査には member id と subject のダイジェストだけを残します。
4. 紐付けた member の `memberships`(tenant ごとの役割)が、そのまま閲覧・操作の範囲になります。詳細は [external-identity-member-mapping](../../knowledge/product/architecture/external-identity-member-mapping.md)。

## 確認手順

```bash
# 1. 設定不足の確認(未設定なら画面が必要な変数を列挙する)
curl -s -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' http://localhost:3050/login | grep -o 'KYBERION_[A-Z_]*'

# 2. リモートからの未認証ページ遷移は /login へ、API は 401 JSON のまま
curl -si -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' https://<公開 origin>/ | head -3
curl -si https://<公開 origin>/api/me | head -3
```

ブラウザで `https://<公開 origin>/` を開き、サインイン → 許可された tenant の内容だけが見えること、未登録アカウントでは説明画面になることを確認します。

## トラブルシュート

| 症状                                         | 原因 / 対処                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 「シングルサインオンが未設定です」           | 画面に列挙された変数を設定。`KYBERION_SESSION_SECRET` の欠落が最も多い                                                           |
| サインイン開始で「IdP がエラーを返しました」 | discovery 取得失敗。issuer の綴り、egress policy の許可ドメイン、Entra の `/common` を確認(`surface_login` 監査ログに理由)       |
| IdP 側で `redirect_uri_mismatch`             | 登録した URI と `<公開 origin>/auth/callback` が文字単位で一致しているか。リモートでは `KYBERION_OIDC_PUBLIC_BASE_URL(S)` が必須 |
| 「このアカウントは登録されていません」       | 期待どおりの fail-closed。表示された `issuer`/`subject` を member の `external_identities` に追加                                |
| サインイン後すぐ 401                         | サーフェス間で `KYBERION_SESSION_SECRET` が違う、または member が停止/`memberships` が空                                         |
| ログイン後に別サーフェスでまたログイン       | cookie はホスト名単位(ポートは区別されない)。ホスト名が違うと別セッション。同一ホスト名なら 1 回のログインで全面に効く           |

## 関連

- [`libs/core/surface/surface-auth-routes.ts`](../../libs/core/surface/surface-auth-routes.ts) — 共通ルート(`/login` `/auth/start` `/auth/callback` `/logout`)
- [`libs/core/surface/oidc-browser-login.ts`](../../libs/core/surface/oidc-browser-login.ts) — code + PKCE、id_token 検証、member 束縛確認
- [`libs/core/authn-providers.ts`](../../libs/core/authn-providers.ts) — `browser-session` provider(`kys1.`)
- [CHRONOS_VIEWER_SCOPE_OPERATIONS](./CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md) — viewer scope と token registry
- [SURFACES](../SURFACES.md) — サーフェスの地図
