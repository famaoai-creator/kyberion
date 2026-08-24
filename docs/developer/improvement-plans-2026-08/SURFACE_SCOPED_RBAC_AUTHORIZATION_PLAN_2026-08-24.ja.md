---
title: Surface / Tenant Scoped RBAC Authorization Plan
category: Planning
tags: [authorization, rbac, surface, tenant, a2ui, headless, self-hosted]
last_updated: 2026-08-24
---

# Surface / Tenant Scoped RBAC 認可計画

## 判断

Surface と tenant が増えたため、認証済み `ViewerContext` だけでなく、headless API / A2UI / UI route が同じ operation 認可を参照する必要がある。ただしこれは SaaS 化ではない。

本計画で扱うのは、OSS / self-hosted / FDE 環境で複数の surface と複数のデータ境界を安全に扱うための **内部認可基盤** である。マネージド SaaS 配布、IdP/SSO、課金、hosted user management、テナント自動受け入れ、公開 REST API/SDK は引き続き対象外とする。

## 現状の課題

1. Chronos は `ViewerContext` と server-side tenant/org/project/tier scope を持つが、operation 認可は `readonly` / `localadmin` の role 比較に寄っている。
2. Concierge と Presence Studio はそれぞれ viewer/auth 実装を持ち、同じ token registry・scope でも認可判定が複製される。
3. A2UI は表示経路であり、認可の正本になってはいけない。manifest の operation と実際の route が同じ policy を使う必要がある。
4. `tenant` はクライアントから渡される filter であり、権限付与の入力ではない。未許可 tenant を narrowing と誤認しない fail-closed 境界が必要である。

## 目標モデル

認証と認可を次のように分離する。

| 軸         | 正本                                 | 意味                                 |
| ---------- | ------------------------------------ | ------------------------------------ |
| principal  | 各 surface の token/session resolver | 誰が呼び出しているか                 |
| role       | `ViewerContext.role`                 | `readonly` / `localadmin` の責務     |
| permission | operation の `required_permissions`  | 何を実行できるか                     |
| scope      | `tenant → organization → project`    | どの資源に適用されるか               |
| tier       | `tierAccess`                         | どのデータ分類まで見えるか           |
| surface    | route / UI / A2UI                    | どの提示経路か。権限そのものではない |

現在の二 role を維持しつつ、共通 `SurfaceAuthorizationContext` と evaluator を使う。将来 role を増やす場合も、tenant を role 名へ埋め込まず、server-side grant の scope として保持する。

## 実装タスク

| ID    | 内容                                                                                                         | 状態     |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------- |
| SR-01 | 共通 `SurfaceAuthorizationContext`、permission、decision、fail-closed evaluator を追加                       | DONE     |
| SR-02 | headless operation に `required_permissions` を追加し、manifest/envelope の available operation 判定を共通化 | DONE     |
| SR-03 | Chronos の read/write headless route を operation 認可へ接続                                                 | DONE     |
| SR-04 | Concierge / Presence Studio の headless route を同じ evaluator へ接続                                        | DONE     |
| SR-05 | tenant/org/project/tier の拒否、permission 欠落、role mismatch の回帰テストを追加                            | DONE     |
| SR-06 | SaaS 方針と tenant/surface 認可基盤の境界をロードマップ・surface・glossary に記載                            | DONE     |
| SR-07 | IdP/SSO、role grant 管理 UI、cross-tenant broker、revocation store を本番運用で実装                          | DEFERRED |
| SR-08 | Computer Surface の manifest、state/stream/OS read、A2UI dispatch を共通 evaluator に接続                    | DONE     |

## 受入条件

- manifest に operation の permission が明示され、permission 欠落は拒否される。
- readonly viewer は read operation のみ、localadmin は既存の bounded write operation まで取得できる。
- resource の tenant/org/project/tier が viewer scope 外なら、surface に関係なく 403 となる。
- A2UI は permission を決めず、headless route と同じ server-side decision を表示可能 operation に反映する。
- client の tenant filter は許可集合を狭めるだけで、scope を広げない。
- SaaS の hosted account management を導入したと解釈されない文書整合性を持つ。

## 非目標と次段階

外部 PDP、OPA/Casbin、SaaS 用の tenant provisioning、IdP/SSO、課金、公開 API の versioning はこの計画に含めない。必要になった場合は、まず現在の `SurfaceAuthorizationContext` を inbound identity / grant store へ adapter 化し、operation contract と scope hierarchy は維持する。

本 PR 後の候補は、`localadmin` の dev-only loopback convenience と tenant 管理者 role の分離、token revocation/cache invalidation、cross-tenant brokered access の監査付き導入である。

## 実装状況

2026-08-25 時点で SR-01〜SR-06 と SR-08 を実装し、core authorization test、headless contract test、Chronos/Concierge/Presence の targeted test、Computer Surface の viewer/auth・route 回帰テストを実行した。SaaS 運用面は未実装かつ本計画の対象外である。
