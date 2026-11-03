---
title: 情報資産の所在登録・取得・完了確認の運用
tags: [information-assets, runbook, intake, collectors, organization]
last_updated: 2026-11-02
---

# 情報資産の所在登録・取得・完了確認の運用

この手順は既存の tenant、active organization、必要なら active project、組織所有の service binding が設定済みであることを前提にする。情報資産機能は binding や外部権限を自動作成しない。構造と境界は [architecture](../architecture/information-assets.md) を参照する。

## 所在を登録する

1. 組織所有者として tenant / organization / project を選ぶ。project は同じ tenant と organization の active record であることを確認する。
2. 接続の `owner_kind` が organization、`owner_ref` が tenant slug、`service_id` が対象 service と一致することを確認する。project 所在は同じ project に紐づく binding を使う。秘密と承認状態は binding 側で管理する。
3. 現在の catalog version を取得する。

```sh
pnpm organization information-assets list --tenant acme --organization-id support
pnpm organization information-assets resolve --tenant acme --organization-id support --asset-type customer.request
```

所在 JSON は `information-asset-catalog.schema.json` の location 契約に従う。たとえば Gmail history の collector_id は `gmail.history`、service_id は `google-workspace`。scope はコマンドで選んだ scope と一致させる。`selectors` は取得条件だけを記述し、認証情報を書かない。

```json
{
  "location_id": "support-mail",
  "asset_type": "customer.request",
  "scope": { "tenant_slug": "acme", "organization_id": "support" },
  "binding_id": "support-google-workspace",
  "service_id": "google-workspace",
  "collector_id": "gmail.history",
  "selectors": { "query": "is:unread" },
  "tier": "confidential",
  "authoritative": true,
  "freshness_seconds": 3600,
  "enabled": true,
  "version": 1,
  "updated_at": "2026-11-02T00:00:00Z"
}
```

最初に dry-run の結果を確認し、適用時には読み取った catalog version を使う。保存時の location version と updated_at は facade が採番する。

```sh
pnpm organization information-assets save --tenant acme --organization-id support --file active/shared/tmp/support-mail.json --expected-version 0
pnpm organization information-assets save --tenant acme --organization-id support --file active/shared/tmp/support-mail.json --expected-version 0 --apply
```

version conflict は新しい list を読み、他の編集と意図を比較してから再適用する。catalog ファイルを手で編集しない。削除も `remove --location-id <id> --expected-version <version> --apply` を使う。

## 取得を既存 Dot に接続する

Dot charter の scope を所在と一致させ、既存 feed trigger の `collector.location_id` に所在 ID を指定する。feed の service_id と action は provider の宣言に一致させる。intake policy は同じ tenant の source を許可する。Dot の event trigger がその source を受け取り、既存の権限・予算・proposal admission が作業化を判断する。

binding は collector が使う全 read action を `allowed_actions` に含め、それぞれの `approval_policy` を明示的な allowed にする。approval_required や未定義 policy は自動取得を拒否する。外部効果用の承認を取得用に流用しない。transport は認可された同じ binding の engine admission を使う。

認証付きの取得は、対象 tenant に対する既存 credential broker が必要になる。既存 task credential binding があれば利用し、なければ設定済み SecretResolver から selected binding の named reference だけを解決して、一回の取得用 binding を作る。resolver には `scope=<tenant>/service-bindings/<binding_id>` と `operation=information_asset.capture` を渡す。task の実行 claim を新しく捏造せず、取得用認可は catalog と read admission で別に確認する。

| 接続                            | 対応する取得認証                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub / Jira `secret-guard`    | service endpoint の `credential_suffixes` に宣言された field に対応する named reference。例示名を推定せず、実際の endpoint 定義と broker のキーを一致させる                           |
| Google Workspace `secret-guard` | `secret_refs: ["GOOGLE_WORKSPACE_CLI_TOKEN"]`。broker で得た token を、台帳で管理された confidential scratch HOME / config directory とともに gws へ渡す。取得後は scratch を解放する |
| Google Workspace `session`      | 既存 task broker が渡す tenant 用の分離済み gws provider environment が必須。単独実行から個人の gws HOME を取り込まない                                                               |
| `none`                          | refs が空の、認証を必要としない対象のみ。Google Workspace は分離された認証経路が必須                                                                                                  |

対応外の `secret:` URI や任意名の reference は推測して解決しない。broker 不在、未対応 reference、未束縛 session は失敗で止まる。SecretResolver の実装が上記 scope と operation を対象 tenant の認証情報へ解決することを確認してから自動運転する。秘密値を所在 JSON、ログ、観測、作業 metadata に書かない。

```sh
pnpm organization information-assets collect --tenant acme --organization-id support --dot support-intake
pnpm organization information-assets collect --tenant acme --organization-id support --dot support-intake --apply
pnpm organization information-assets work --tenant acme --organization-id support
```

collect の実行を定期化するときは既存 Dot の cadence / event intake を使う。独立したメール daemon や別の作業キューを作らない。外部 API の接続確認は対象 tenant の認可済み binding で行い、他 tenant の認証を試行しない。

## 状態を読み、障害を扱う

| 表示                           | 意味と対応                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| unobserved                     | 未取得。所在登録だけではデータの存在・最新性を証明しない                                                                  |
| available=true / current=false | 取得先は接続可能だが、未観測・古い・不完全な観測のいずれか。coverage と readiness を確認する                              |
| partial                        | ページ予算や途中の受理により全範囲を覆っていない。保存済み cursor / pending page から既存取得経路で継続する               |
| failed                         | 認可・preset・provider 応答・永続化などの失敗。原因を修正してから再実行する                                               |
| full_sync_required             | provider が incremental cursor を失効した。既存状態を証拠として残し、対象範囲を確認して明示的な再同期を計画する           |
| checkpoint identity mismatch   | 所在 version / selectors / binding 等が変化した。古い cursor を新しい条件へ移植しない。変更前の範囲と再取得方針を確認する |
| waiting_approval               | 既存 approval を通す必要がある。承認状態を台帳へ書き込まない                                                              |
| waiting_counterpart            | 相手の応答や期限を待っている。期限・recheck 条件を確認する                                                                |
| unknown_effect / needs_recheck | 外部効果の結果を確認できていない。receipt と外部 readback を先に調べ、同じ変更を無条件で再送しない                        |

symlink、非 regular file、不正 JSON、不正 schema は安全な空データへ置き換えず停止する。対象パス・変更履歴・認可を確認してから owner の管理操作で修復する。tenant / organization / project の mismatch は selector の変更で回避せず、正しい親子関係と実行 scope を確認する。

## 完了を確認する

メール分類・返信準備・アクション抽出・レビュー準備などの成果物型は、保存先の実体と hash の一致をもってその recipe の完了とする。メール送信や Jira 承認など外部効果を含む作業は、既存 service actuator による承認と実行後に対象の外部状態を読み戻す。準備成果物の作成を、外部送信・承認そのものの完了として報告しない。

既存 ingest ledger は明示的に取り込まれた knowledge の来歴である。所在一覧や collector observation から自動的に ingest せず、必要な場合だけ既存の tenant 指定 ingest ceremony を使う。
