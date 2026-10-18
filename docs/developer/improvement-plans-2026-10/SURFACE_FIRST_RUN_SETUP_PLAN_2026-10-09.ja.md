---
title: サーフェスの初回セットアップ — OIDC 設定前でも owner・認証情報・SSO 設定を画面で完了する
category: Improvement Plan
tags: [surfaces, authentication, oidc, onboarding, first-run, concierge, multi-tenant]
last_updated: 2026-10-09
status: completed
mission: MSN-SURFACE-FIRSTRUN-20261009
---

# サーフェスの初回セットアップ

## 判断

OIDC を設定するまで、サーフェスにはほぼログインできない。原因は 3 つある。

1. **Next.js 系 3 面は同じマシンのブラウザでも loopback と判定できない。** concierge / chronos-mirror-v2 / operator-surface は Next 16 で `req.ip` が無く、`KYBERION_TRUST_PROXY` 無しでは `localhost` からでも 401 → `/login`(未設定画面)か `/signin`(トークン入力)になる。
2. **OIDC 設定は環境変数でしか与えられない。** `resolveOidcLoginConfig` は `KYBERION_OIDC_*` だけを読み、反映には全サーフェスの再起動が要る(セッション鍵だけは secret-guard `kyberion-browser-session` からも読める)。
3. **最初の owner を作る入口が無い(鶏と卵)。** `POST /api/members` と `PATCH /api/members/:id`(IdP 紐付け)は owner viewer を要求し、招待も owner が発行する。`pnpm organization member` は `link-identity` / `unlink-identity` だけで、トークン付き owner を作るコマンドも無い。

そこで、**ブラウザからサインインできる owner がまだ居ない間だけ**、ホストで発行した一回限りのセットアップコードを持つブラウザに、owner 作成・アクセストークン発行・OIDC 設定を concierge の画面で行わせる。

## 既存資産との関係

- member / tenant の作成は `writeMemberProfile` / `writeTenantProfile`、トークンは `issueChronosAccessToken`、保存は `secretGuard.storeConnectionDocument` をそのまま使う。新しい永続ストアは作らない。
- 認可経路(`resolveAuthnSurfaceViewerScope` → `ViewerContext`)とログインフロー(`surface-auth-routes`)は変えない。発行するのは既存の registry token で、`/signin` と Bearer ヘッダーで従来どおり使える。
- `loopback` は従来どおり owner member(`owner`)に解決される。初回セットアップの既定 member id も `owner` にして、loopback とトークンが同じ member を指すようにする。

## 設計

| 論点                | 決定                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 開放条件(unclaimed) | claim 済みの印が無く、かつ「有効な member で owner 所属を持ち、`access_registrations` か `external_identities` を持つ者」が 1 人も居ないとき。つまり「ブラウザからサインインできる owner が居ない」状態                                                 |
| 本人性の証明        | ホストで `pnpm organization first-run code` を実行して得る一回限りのコード。**先着順にしない。** Host / `X-Forwarded-For` は使わない                                                                                                                    |
| コードの保管        | secret-guard 文書 `kyberion-first-run` に SHA-256 ハッシュ・期限・失敗回数だけを保存(平文は CLI の出力 1 回のみ)。既定 30 分、失敗 5 回で失効、使用で失効                                                                                               |
| URL                 | `http://localhost:3050/setup/first-run#code=…`。コードは fragment に置き、サーバーログやプロキシのアクセスログに残さない。画面は読み取り後に fragment を消す                                                                                            |
| claim の内容        | tenant が無ければ作成 → member(既定 `owner`)を作成または再利用し、**登録済みの全 tenant** に owner 所属を付与(`ensureOwnerMember` と同じ範囲) → owner に紐付く registry token(`localadmin`)を発行して 1 回だけ返す → claim 済みの印を書き、コードを消す |
| 閉鎖                | claim 済みの印により永久に閉じる。印が消えても、トークンを持つ owner が居る限り開放条件を満たさない                                                                                                                                                     |
| OIDC 設定の保存     | secret-guard 文書 `kyberion-oidc`(issuer / client_id / client_secret / provider_label / scopes / public_base_url)。client_secret は応答に返さない(設定済みかどうかだけ)                                                                                 |
| 優先順位            | `KYBERION_OIDC_ISSUER` か `KYBERION_OIDC_CLIENT_ID` が環境変数にあれば**環境変数一式**を使う(混在させない)。無いときだけ secret-guard を読む                                                                                                            |
| 反映                | `resolveOidcLoginConfig` はリクエストごとに評価されるので、保存後は再起動なしで全サーフェスに効く(secret-guard はプロセスをまたいで同じファイル)                                                                                                        |
| セッション鍵        | OIDC 保存時に `browserSessionKey()` が無ければ `kyberion-browser-session` に 32 バイトの乱数鍵を生成。環境変数の鍵が短すぎて無効な場合は自動生成せず警告を返す                                                                                          |
| OIDC 設定の権限     | インスタンス全体の設定なので「インスタンス owner」= 登録済みの全 tenant で owner 所属を持つ有効な member、かつ localadmin の viewer に限る。cookie 認証の変更系は従来の same-origin 検査                                                                |
| claim API の防御    | 未認証で受けるため、Origin が自ホスト以外なら 403、クライアントあたり 10 回/分のレート制限、コードの失敗上限                                                                                                                                            |
| 監査                | コード発行・claim・失敗・OIDC 保存を `auditChain` に記録。secret-guard の書き込みは `CONFIG_CHANGE` として ledger にも残る                                                                                                                              |
| egress              | Google / Microsoft 以外の IdP は `egress-policy.json` の許可が必要。ガバナンスファイルなので画面からは変更せず、手順を案内するだけ                                                                                                                      |
| 同時実行            | claim は concierge プロセス内で同期 I/O のみで完結し、最初にコードを消費してから書き込む。別プロセスからの同時 claim は想定しない(入口は concierge だけ)                                                                                                |

## 実装

| 段階 | 内容                                                                                                                                                                                                                                                                                                     | 状態                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P1   | `libs/core/surface/oidc-login-settings.ts`: secret-guard の OIDC 設定の読み書き・検証・要約。`resolveOidcLoginConfig` のフォールバック                                                                                                                                                                   | 実装                                    |
| P2   | `libs/core/surface/first-run-setup.ts`: 開放判定、コード発行・検証、claim                                                                                                                                                                                                                                | 実装                                    |
| P3   | `pnpm organization first-run <code\|status>`                                                                                                                                                                                                                                                             | 実装                                    |
| P4   | concierge: `/api/setup/first-run`(GET 状態 / POST claim)、`/api/setup/oidc`(GET 要約 / PUT 保存)、画面 `/setup/first-run`(claim → トークン表示 → OIDC 設定)、middleware の通過、`/login` 未設定画面からの導線                                                                                            | 実装                                    |
| P5   | 運用手順(`SURFACE_OIDC_LOGIN_OPERATIONS.ja.md`)と changelog                                                                                                                                                                                                                                              | 実装                                    |
| P6   | IdP アカウントの自己紐付け: サインイン中の member が `/api/setup/link-identity` から IdP ログインを始める。紐付け先の member id は HMAC 署名付きのログイン transaction(`tx.link`)にだけ入れ、callback で未紐付けのアカウントだけを紐付ける(別 member のアカウントは拒否、停止中の member には紐付けない) | 実装(MSN-SURFACE-IDP-SELFLINK-20261009) |

## 手順(利用者から見た流れ)

```bash
# ホスト(サーバー)で 1 回だけ
pnpm organization first-run code            # → http://localhost:3050/setup/first-run#code=XXXX-…
```

1. 表示された URL を開き、tenant と自分の表示名を入れて「セットアップする」。
2. 発行されたアクセストークンが 1 回だけ表示される。このブラウザはそのままサインイン済みになる(他のサーフェスでは `/signin` や Bearer ヘッダーで使う)。
3. 続けて IdP の issuer / client id / client secret を入れて保存する。表示されるリダイレクト URI を IdP に登録する。
4. 「自分のアカウントを紐付ける」から IdP で一度サインインすると、その IdP アカウントが自分に紐付く。以後は全サーフェスの `/login` から IdP でサインインできる。

## 検証

- `libs/core/surface/first-run-setup.test.ts`: 開放判定、コードの期限・失敗上限・単回使用、claim の副作用(tenant / member / token / 閉鎖)、claim 後の再 claim 拒否。
- `libs/core/surface/oidc-login-settings.test.ts` と `oidc-browser-login.test.ts`: 検証規則、secret 非開示、環境変数優先、フォールバック。
- concierge の route テスト: claim の Origin 検査とエラー応答、OIDC 保存のインスタンス owner 要求。
- CLI の引数解析テスト。
- 実機確認(個人データが空の worktree、concierge を別ポートで起動): `first-run code` → 誤コード 403 / 他 Origin 403 → claim 成功でトークン発行・状態 `claimed`・同コード再利用拒否 → トークン無しの `/api/setup/oidc` 401、owner トークンで要約取得 → 不正 issuer 400 → 保存でセッション鍵生成 → `/login` に IdP ボタンが出て初回セットアップ導線が消える。client secret は平文で保存されない。

## リスク

- **コードの漏えい**: 30 分・単回・失敗 5 回で失効。claim 後は無効。漏えい時は `pnpm organization first-run code` の再発行で旧コードを置き換える。
- **既存環境への影響**: 既に owner がトークンや IdP 紐付けを持つ環境では開放条件を満たさず、画面は「セットアップ済み」を返すだけ。環境変数で OIDC を設定済みの環境は挙動が変わらない。
- **コードの失効を狙う妨害**: concierge に届く者は誤コード 5 回でコードを失効させられる(総当たりは約 99 bit で非現実的)。Next 系はクライアント IP を取れないためレート制限のキーも共有になる。失効してもホストで再発行すれば済むので、初回セットアップ中は concierge を外部に公開しない運用とする。
- **claim 途中の失敗**: コード消費後に書き込みが失敗すると 500 になり、発行済みトークンが registry に残ることがある。生トークンは誰にも返っていないので使えず、owner の登録が無ければ未 claim のままなので、コードを再発行してやり直せる。
- **multi-tenant**: OIDC 設定はインスタンス全体なので、全 tenant の owner に限定した。tenant ごとの IdP は対象外。
