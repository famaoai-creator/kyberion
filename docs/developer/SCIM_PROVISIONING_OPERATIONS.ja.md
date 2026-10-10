---
title: SCIM 2.0 ユーザープロビジョニング 運用手順
tags: [surfaces, scim, provisioning, identity, entra, okta, multi-tenant, organization]
last_updated: 2026-10-10
---

# SCIM 2.0 ユーザープロビジョニング 運用手順

組織の IdP(Microsoft Entra ID、Okta など)から、Kyberion の組織メンバーを SCIM 2.0 で作成・更新・停止します。入社した人は IdP に追加するだけでメンバーになり、退職した人は IdP で無効にするだけで止まります。

> **IdP が決めるのは「誰か」だけです。** 権限(ロール)、所属、委任は Kyberion の member registry が正本で、IdP からは変えられません([再設計計画 決定 2](./improvement-plans-2026-09/SURFACE_ACTOR_MODEL_REDESIGN_PLAN_2026-09-30.ja.md))。SCIM は招待と同じ名簿(`knowledge/personal/members/`)に入ります。

## できること・できないこと

| 操作                          | 動作                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ユーザー作成(POST)            | メンバーを作り、この組織に**トークンの既定ロール**(既定 `viewer`)で所属させる。`externalId` はトークンの issuer の下で外部 ID として紐付け、IdP でのサインインがこのメンバーに解決される                                                                            |
| 取得・一覧(GET)               | この組織に所属するメンバーだけ。`filter=userName eq "…"` / `externalId eq "…"`、`startIndex` / `count`(最大 200)                                                                                                                                                    |
| 置換(PUT)・部分更新(PATCH)    | `userName` / `name` / `emails` / `displayName` / `externalId` / `active`。`externalId` を含まない PUT は外部 ID を**変えない**(紐付けを外すのは PATCH `remove`、または値 `null` を明示したとき)                                                                     |
| 削除(DELETE)・`active:false`  | **停止のみ**(`status: suspended`)。メンバーは削除しない。停止したメンバーのブラウザセッションと member トークンは次のリクエストから拒否される                                                                                                                       |
| ロール                        | **変えられない**。`roles` / `groups` / `entitlements` への PATCH は 400 `invalidPath`。POST/PUT に含めても無視する。owner は作れない                                                                                                                                |
| 変更できるメンバー            | この組織でのロールが owner **ではなく**、トークンの既定ロール以下(`viewer` < `operator` < `approver`)のメンバーだけ。owner や既定ロールより上のメンバーは、どの属性も変えられず停止もできない(403)。読み取りはできる                                                |
| 外部 ID(`externalId`)         | 設定・変更・削除できるのは、外部 ID を**すべてこの組織の SCIM トークンが紐付けた**メンバーか、外部 ID もアクセストークンも持たないメンバーだけ。owner が Kyberion で紐付けた ID(OIDC・Slack など)やトークンを持つメンバー、別の組織の SCIM が紐付けたメンバーは 403 |
| 再有効化(`active:true`)       | **SCIM が停止したメンバーだけ**。owner が Kyberion で停止したメンバーは SCIM から再有効化できない(403)。owner が状態を変えると、以後はその判断が優先される                                                                                                          |
| 他の組織にも所属するメンバー  | `userName` / `name` / `emails`(組織側の属性)は変えられる。`active` / `displayName` / `externalId`(メンバー全体に効く属性)は 403。Kyberion の owner が変更する                                                                                                       |
| 他の組織のメンバー            | 見えない(404)。フィルタで探しても 0 件                                                                                                                                                                                                                              |
| Groups / Bulk / ソート / ETag | 未対応(ServiceProviderConfig で `supported: false`)                                                                                                                                                                                                                 |

`title`、`phoneNumbers`、`addresses`、`preferredLanguage` など Kyberion が保存しない属性や、enterprise 拡張(`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`)は受け付けて無視します(Entra ID の既定マッピングのままで同期が失敗しないため)。

## 1. SCIM トークンを発行する(owner)

組織ごとに専用のトークンを発行します。**メンバーのアクセストークンとは別物**で、その組織の `/scim/v2` にしか使えません(他の API や他の組織には 401)。

```bash
pnpm organization scim-token issue --tenant acme-corp --label "Entra ID" \
  --issuer https://login.microsoftonline.com/<directory-id>/v2.0
```

- 実行する人は対象組織の **active な owner** です(`--by <member-id>`、既定は `owner`)。`--by` は自己申告で、CLI はそれを検証しません。トークンの発行・失効はこのリポジトリで CLI を実行できる人の権限と同じ強さです。
- `--issuer` は、メンバーが IdP でサインインするときの OIDC issuer です。省略すると `KYBERION_OIDC_ISSUER`(または初回セットアップで保存した SSO 設定)を使います。https のみ(loopback の開発用 IdP だけ http 可)。`https://slack.com` などチャットの識別子用 issuer は指定できません。
- **issuer は id_token の `iss` と一字一句同じ値を指定します**(末尾の `/` も含めて)。サインインは `iss` をそのまま照合するため、トークンには指定した値をそのまま保存し、外部 ID もその値で紐付けます。SCIM 内部の比較(重複確認・読み出し)は末尾の `/` や大文字小文字の違いを同一視します。
- `--default-role` は SCIM で作られたメンバーのロールです。`viewer`(既定)/ `operator` / `approver`。`owner` は指定できません。
- 出力の `token`(`kscim~<組織>~<token_id>~<secret>`)は**この 1 回しか表示されません**。保存されるのは secret の sha256 だけです。

一覧と失効:

```bash
pnpm organization scim-token list --tenant acme-corp
pnpm organization scim-token revoke --tenant acme-corp --id scim-0123456789abcdef
```

失効したトークンは次のリクエストから 401 になります。トークンの入れ替えは「新しいトークンを発行 → IdP に設定 → 古いトークンを失効」の順で行います。

## 2. IdP を設定する

SCIM のベース URL は concierge の公開 URL + `/scim/v2` です(例: `https://concierge.example.com/scim/v2`)。IdP のクラウドから届く必要があるため、https で公開されたリバースプロキシの背後に置いてください。認証方式は Bearer トークン(上で発行したもの)です。

### Microsoft Entra ID

1. エンタープライズアプリケーション → 新しいアプリケーション → 独自のアプリケーション(ギャラリー外)を作成。
2. プロビジョニング → モード「自動」。
   - テナントの URL: `https://<concierge>/scim/v2`
   - シークレットトークン: 発行した `kscim~…`
   - 「テスト接続」は `GET /Users?filter=userName eq "<ランダム値>"` を送り、空の一覧が返れば成功です。
3. 属性マッピング(ユーザー): 既定のままで動きます。`roles` や `appRoleAssignments` を追加しないでください(ロールは Kyberion で決めるため、PATCH が 400 になります)。
4. 「ユーザーとグループ」で対象者を割り当て、プロビジョニングを開始します。割り当て解除・アカウント無効化は PATCH `active: False` として届き、Kyberion では停止になります。

> **Entra ID のサインインとの紐付け**: Entra ID の id_token の `sub` はアプリごとのペアワイズ値で、ユーザー属性としては取り出せません。既定の `externalId`(`mailNickname`)は `sub` と一致しないため、SCIM で作ったメンバーは**そのままでは Entra ID のサインインに解決されません**。初回サインイン時の「未登録」画面に表示される `issuer` / `subject` を、owner が 設定 › 組織とメンバー(または `pnpm organization member link-identity <member-id> --issuer … --subject …`)で紐付けてください。停止・再有効化は SCIM のまま効きます。ただし owner が同じ issuer の下に紐付けた後は、そのメンバーの `externalId` を SCIM から変更できません(403)。

### Okta

1. アプリケーション → アプリ統合を作成 → SWA または OIDC アプリに SCIM プロビジョニングを有効化(「SCIM 2.0 Test App (Header Auth)」でも可)。
2. Provisioning → Integration:
   - SCIM connector base URL: `https://<concierge>/scim/v2`
   - Unique identifier field for users: `userName`
   - Supported provisioning actions: Push New Users / Push Profile Updates(Groups は使わない)
   - Authentication Mode: HTTP Header、Authorization: `Bearer kscim~…`
3. To App: Create Users / Update User Attributes / Deactivate Users を有効化。
4. `externalId` を id_token の `sub`(Okta のユーザー ID)と同じ値になるようマッピングすると、SCIM で作ったメンバーがそのまま Okta のサインインに解決されます。`--issuer` は Okta の issuer(`https://<org>.okta.com` または `https://<org>.okta.com/oauth2/default`)を、サインイン設定の `KYBERION_OIDC_ISSUER` と同じ値で指定します。

## 3. 確認と監査

- 発行・失効は組織ごとの台帳 `knowledge/confidential/<組織>/scim/scim.ledger.jsonl` に残ります。
- 発行・使用・拒否・失効と、ユーザーの作成・置換・更新・停止(拒否されたものを含む)は監査チェーン(`active/shared/logs/audit/`)に `scim.token.*` / `scim.user.*` として記録されます。記録するのは組織、メンバー ID、トークン ID で、トークン自体は記録しません。
- SCIM 専用の属性(`userName` / `name` / `emails`)は組織のデータとして `knowledge/confidential/<組織>/scim/users/` に置きます。状態・所属・外部 ID は member registry が正本です。
- レート制限: 認証前はクライアントのアドレス、認証後はトークンごとに、それぞれメソッドごと 300 回/分。超過は 429 + `Retry-After`。リバースプロキシの背後では `KYBERION_TRUST_PROXY=true` にしないと全リクエストが同じアドレス扱いになる(接続元アドレスが分からず `KYBERION_TRUST_PROXY` も off のときは、認証前の上限を全クライアントが 1 つのバケット `scim-ip:unknown` で共有するため、不正なリクエストが IdP の同期を 429 にしうる)。
- 組織が停止・アーカイブ中、またはテナント登録にない場合、その組織のトークンは 401(監査は `tenant_inactive` として 1 分 1 件にまとめて記録)。
- `meta.location` と `Location` ヘッダーは、`KYBERION_OIDC_PUBLIC_BASE_URLS`(`concierge=…`)または `KYBERION_OIDC_PUBLIC_BASE_URL` で宣言した公開 URL を使います。宣言がないときはリクエストの Host ヘッダーから組み立てるため、公開環境では宣言してください。
- 不正なトークンの拒否は、組織と理由ごとに 1 分 1 件にまとめて記録します(まとめた件数は次の記録の `suppressed_since_last`)。SCIM トークンを発行していない組織名を名乗る拒否は、組織に紐付けずに記録します。
- リクエスト本文は 64 KiB まで。`Content-Length` が上限を超える場合は読まずに 413、ない場合も上限を超えた時点で読むのをやめて 413。

## 既知の制限

- **全メンバーの走査**: `externalId` の重複確認と一覧は、名簿(`knowledge/personal/members/`)の全メンバーを毎回読みます(O(N))。数千人規模までを想定しています。
- **issuer の先取り**: `externalId` の重複は issuer 単位で全組織にまたがって確認します。ある組織の SCIM が先に同じ issuer + `externalId` を紐付けると、別の組織の SCIM は同じ人を作れません(409 `uniqueness`)。同じ IdP を複数の組織で共有する場合は、片方の組織で作ったメンバーを owner がもう一方の組織にも所属させてください。
- **issuer の表記**: サインインは id_token の `iss` を一字一句で照合します(正規化しません)。SCIM は `--issuer` の値をそのまま紐付けに使うので、`KYBERION_OIDC_ISSUER` と同じ表記で発行してください。設定 › 組織とメンバー で owner が紐付ける ID は issuer の末尾の `/` を取り除くため、`iss` が `/` で終わる IdP(Auth0 など)では、その紐付けはサインインに解決されません。
- **認証前のレート制限の共有バケット**: 接続元アドレスが分からず `KYBERION_TRUST_PROXY` が off のときは、認証前の上限を全クライアントが `scim-ip:unknown` で共有します。
- **`--by` は自己申告**: CLI はリポジトリを操作できる人を信頼します。トークン発行の強さは CLI へのアクセス管理と同じです。

## トラブルシューティング

| 症状                                              | 原因と対処                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 401 `A valid SCIM provisioning token is required` | トークンの誤り・失効・別組織のもの、または組織が停止中・未登録。`scim-token list` で状態を確認し、必要なら再発行                      |
| 409 `uniqueness`                                  | 同じ `userName`、または同じ `externalId`(issuer 単位)が既に別のメンバーに使われている。他の組織のメンバーを SCIM が取り込むことはない |
| 403 `member also belongs to another organization` | 複数の組織に所属するメンバーの停止・表示名・外部 ID は、Kyberion の owner が 設定 › 組織とメンバー で変更する                         |
| 403 `member holds the owner role or a role above` | owner、またはトークンの既定ロールより上のメンバー。Kyberion の owner が 設定 › 組織とメンバー で変更する                              |
| 403 `suspended in Kyberion, not by SCIM`          | owner が停止したメンバー。再有効化は owner が行う                                                                                     |
| 403 `externalId was bound in Kyberion`            | owner が紐付けた外部 ID。変更は owner が行う                                                                                          |
| 400 `invalidPath`                                 | ロール・グループの PATCH、または未対応の属性。IdP の属性マッピングから外す                                                            |

関連: [サーフェス OIDC ログイン 運用手順](./SURFACE_OIDC_LOGIN_OPERATIONS.ja.md) · [マルチテナント運用](../../knowledge/product/architecture/multi-tenant-operations.md) · 実装: `libs/core/organization/scim-users.ts` / `scim-token-registry.ts` / `scim-protocol.ts`、concierge `src/app/scim/v2/`
