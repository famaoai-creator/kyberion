---
title: Chronos viewer scope 運用手順
tags: [chronos, security, authorization, multi-tenant]
last_updated: 2026-10-26
---

# Chronos viewer scope 運用手順

この機構はログイン基盤ではなく、Chronos の HTTP リクエストに viewer principal と tenant / organization / project の許可集合を付与するための境界です。IdP、SSO、人間ユーザー管理は対象外です(ブラウザからのサインインは別機構: [サーフェス OIDC ログイン](./SURFACE_OIDC_LOGIN_OPERATIONS.ja.md))。

## 段階導入

`KYBERION_VIEWER_SCOPE` は `off` / `warn` / `enforce` を取ります。既定値は `warn` です。

- `off`: 既存互換の選択を許可し、監査記録もしません。
- `warn`: 既存互換の選択を許可しますが、許可外 tenant の指定を audit chain に記録します。
- `enforce`: viewer の許可集合外の tenant 指定を HTTP 403 にします。

監査 chain で `action=viewer_scope` の warn 記録が一定期間 0 件であることを確認してから、運用環境ごとに `enforce` へ切り替えます。切り替えは単独コミットで行い、表示の欠落があれば直ちに `warn` へ戻せます。

## API ルート契約

`/api/healthz` を除くすべての Chronos API ルートは、通常の role guard 通過後に `resolveViewerContextForRequest` を実行します。これにより、登録外 token や principal のない remote request は個別ルートでも fail-closed になります。`healthz` だけが明示的な公開 probe です。

ファイル・成果物・runtime の読み取りは、可能な範囲で `withViewerExecutionContext` の内側で行い、単一 tenant viewer の境界を tier guard へ伝播します。tenant を選択できる可視化ルートは、viewer の許可集合を先に解決した後で query を交差させます。回帰防止として `src/app/api/route-contract.test.ts` が route module の viewer 契約を走査します。

### 顧客の決定のルート（CD-12）

`GET /api/customer-decisions/overview`・`/case?tenant=&case=`・`/learning?tenant=[&date=]` は、ひとつのテナントの顧客の決定を読むだけのルートです。三つとも `src/lib/customer-decision-viewer-scope.ts` の `resolveCustomerDecisionTenant` で、次の順に確かめてから子プロセスを動かします(控えを返す前にも毎回確かめます)。

1. プロジェクトに限られた閲覧者と `project_id` の指定は 403。テナント全体の画面だからです。
2. `tenant` は閲覧者の許可集合を絞るだけです。許可集合が一つならそのテナント、複数か全テナントで `tenant` がなければ 400。
3. テナントの登録簿にないテナントは 403。
4. 閲覧者が confidential tier に届かなければ 403、テナントの組織(id はテナントの slug)に届かなければ 403。

`case` は台帳の案件 id の形、`date` は `YYYY-MM-DD` でなければ 400 で、子プロセスは動きません。Chronos は決定の置き場を読みません。governed facade(`dist/scripts/customer_decision.js overview`)を、そのテナントに結び付けたシステム役割なしの子プロセスとして、種類ごとに決まった引数で動かします(同時に 4 つまで、種類・テナント・引数ごとに 15 秒の控え)。応答は版・テナント・案件・日付を確かめた形に組み直し、値・選択肢・理由・コメント・名前は入りません。案件やレポートがなければ 404、facade が未ビルドなら 503、時間切れは 504、ほかは 502 で、どれも決まった文面だけを返します。

middleware は edge で secret-guard のファイル読み取りを行わない設計です。したがって middleware は credential/loopback の早期境界、token registry を伴う viewer 解決は route 側、という二段構成を維持します。

## headless / A2UI operation 認可

headless route と A2UI route は、viewer scope のほかに共通 `SurfaceAuthorizationContext` で operation の `required_permissions` を評価します。manifest の `available_operations` も同じ判定から生成されるため、UI の表示可否と API の実行可否を別の role 比較で実装しません。`warn` は既存の非 headless 移行観測用であり、headless の tenant/org/project/tier scope や operation permission を拡大する bypass には使いません。

## scoped token の登録

token の平文は保存しません。SHA-256 を計算し、secret-guard の接続文書へ登録します。

```json
{
  "tokens": [
    {
      "token_hash": "<sha256(token)>",
      "role": "readonly",
      "tenant_slugs": ["tenant-acme"],
      "organization_ids": ["org-acme"],
      "project_ids": ["project-acme"],
      "label": "acme-readonly"
    }
  ]
}
```

保存先は `knowledge/personal/connections/chronos-access.json` です。AC-05 の `KYBERION_SECRET_ENCRYPTION` が有効な環境では、通常の secret-guard 接続文書として暗号化して保存します。ログ、エラー、監査には token の値を出しません。

登録は `issueChronosAccessToken`（`libs/core/chronos-access-registry.ts`。Concierge の「組織とメンバー」から token を発行する経路）で行います。token はこの関数が生成し、平文は一度だけ返します。

Chronos は `SYSTEM_ROLE=chronos_mirror_v2` で起動されるため、自分のロールでは個人 tier を読めません。registry の読み取り（`src/lib/viewer-context.ts` と `src/lib/api-guard.ts`）は `chronos_token_registry_reader` ロールを引き受けて行います。このロールはこのファイルの読み取りしか許可されていません（TR-01）。この経路が壊れると、registry があるだけで env token を含むすべての token が 401 になります。`pnpm kyberion check plugin-views-e2e` は両方の起動モードで registry に token を登録し、その token で認証できることを確認します。

既存の `KYBERION_API_TOKEN` と `KYBERION_LOCALADMIN_TOKEN` は all-scope の互換 token です。`KYBERION_LOCALHOST_AUTOADMIN=false` にすると loopback の無資格自動 admin を無効化できるため、すべての利用者に token が必要になります。クエリの tenant / organization / project は登録済み許可集合を narrow するだけで、許可集合を拡張しません。

## 関連 transport

Chronos は loopback (`127.0.0.1`) に明示束縛されます。Computer Surface は loopback または bearer token、agent runtime supervisor は Unix socket 0600、TCP 利用時は loopback と共有 token を要求します。
