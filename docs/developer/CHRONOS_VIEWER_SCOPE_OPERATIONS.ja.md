---
title: Chronos viewer scope 運用手順
tags: [chronos, security, authorization, multi-tenant]
last_updated: 2026-08-06
---

# Chronos viewer scope 運用手順

この機構はログイン基盤ではなく、Chronos の HTTP リクエストに viewer principal と tenant / organization / project の許可集合を付与するための境界です。IdP、SSO、人間ユーザー管理は対象外です。

## 段階導入

`KYBERION_VIEWER_SCOPE` は `off` / `warn` / `enforce` を取ります。既定値は `warn` です。

- `off`: 既存互換の選択を許可し、監査記録もしません。
- `warn`: 既存互換の選択を許可しますが、許可外 tenant の指定を audit chain に記録します。
- `enforce`: viewer の許可集合外の tenant 指定を HTTP 403 にします。

監査 chain で `action=viewer_scope` の warn 記録が一定期間 0 件であることを確認してから、運用環境ごとに `enforce` へ切り替えます。切り替えは単独コミットで行い、表示の欠落があれば直ちに `warn` へ戻せます。

## API ルート契約

`/api/healthz` を除くすべての Chronos API ルートは、通常の role guard 通過後に `resolveViewerContextForRequest` を実行します。これにより、登録外 token や principal のない remote request は個別ルートでも fail-closed になります。`healthz` だけが明示的な公開 probe です。

ファイル・成果物・runtime の読み取りは、可能な範囲で `withViewerExecutionContext` の内側で行い、単一 tenant viewer の境界を tier guard へ伝播します。tenant を選択できる可視化ルートは、viewer の許可集合を先に解決した後で query を交差させます。回帰防止として `src/app/api/route-contract.test.ts` が route module の viewer 契約を走査します。

middleware は edge で secret-guard のファイル読み取りを行わない設計です。したがって middleware は credential/loopback の早期境界、token registry を伴う viewer 解決は route 側、という二段構成を維持します。

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

既存の `KYBERION_API_TOKEN` と `KYBERION_LOCALADMIN_TOKEN` は all-scope の互換 token です。`KYBERION_LOCALHOST_AUTOADMIN=false` にすると loopback の無資格自動 admin を無効化できるため、すべての利用者に token が必要になります。クエリの tenant / organization / project は登録済み許可集合を narrow するだけで、許可集合を拡張しません。

## 関連 transport

Chronos は loopback (`127.0.0.1`) に明示束縛されます。Computer Surface は loopback または bearer token、agent runtime supervisor は Unix socket 0600、TCP 利用時は loopback と共有 token を要求します。
