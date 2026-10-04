---
title: マネージド SaaS 実用化計画
tags: [improvement-plan, 2026-09, saas, production-readiness, multi-tenant]
last_updated: 2026-09-30
status: active
---

# マネージド SaaS 実用化計画

## 目的と判断

Kyberion の提供形態に managed SaaS を加える。OSS / self-hosted は引き続き一級の提供形態として維持し、SaaS の顧客向け認証・運用・契約責任を既存の内部認可だけで満たしたと見なさない。

初期形態は**顧客ごとの専用環境を使う、招待制の管理運用パイロット**とする。これは SaaS を見送る判断ではなく、共有ランタイムのテナント分離を先に仮定せず、顧客価値・運用原価・サポート負荷を小さく検証する段階である。共有マルチテナントは追加の隔離・運用ゲートを通過した後に別途判断する。

この方針の策定だけでは本番提供の承認にならない。環境ごとの go / no-go は [本番 readiness G1–G7](../PRODUCTION_READINESS_PLAN.ja.md)、[30 日運用証跡テンプレート](../../operator/templates/production-evidence-30day-ops.md)、および顧客別の契約・プライバシー条件に基づいて記録する。

## 提供段階

| 段階                    | 提供形態                                                           | 進め方                                                                                         | 次段階への条件                                                            |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0. 顧客と運用の検証     | 社内 dog-food / design partner                                     | 対象業務、データ分類、利用者、サポート窓口、保管地域、停止・削除条件を確認する                 | 顧客責任者と運用責任者が明確で、受入試験とデータ取扱条件が合意済み        |
| 1. 専用環境パイロット   | 顧客ごとの runtime / storage / secrets / backup を分離した管理環境 | 招待制。provisioning は承認・監査可能な手動手順でよい。利用範囲と停止手順を限定する            | 下記の専用環境ゲート、復元演習、30 日運用証跡、顧客レビューがすべて完了   |
| 2. 専用環境での一般提供 | 顧客ごとの専用環境を管理運用するサービス                           | 契約、SLO、料金、サポート時間、変更通知、データ export / deletion をサービス仕様として公開する | 継続的な運用測定が安定し、共通化できる provisioning と upgrade 手順が整う |
| 3. 共有ランタイムの評価 | 複数顧客が同じ runtime を使う構成                                  | 専用環境とは別に threat model、分離試験、負荷・障害試験を実施する                              | 下記の共有テナントゲートを独立レビューで通過し、経営判断で承認            |

## 専用環境パイロットの開始ゲート

- **責任境界**: 顧客ごとに責任者、管理者、利用者、サポート担当を定義する。顧客向け session は認証済み principal に結び付け、共有の管理者 token を利用者認証の代わりにしない。
- **環境とデータ**: runtime、永続 storage、secret、backup、audit の所在と管理主体を記録する。顧客データを public / personal / confidential に正しく分類し、環境間の credential と保存領域を共有しない。
- **運用と復旧**: alert、on-call、incident severity、連絡先、upgrade / rollback、backup 保持期間を決める。実データ相当の backup を別環境へ restore し、復旧時間と欠損有無を記録する。
- **プライバシーと契約**: 収集データ、外部 provider への送信、保管地域、保持・削除、subprocessor、顧客 export、障害通知を合意する。必須条件が未確定ならパイロットを開始しない。低リスク項目だけ未決の場合は、対象データ・顧客を限定し、期限付き補償策と責任者を記録してから開始する。
- **開始前の受入証跡**: 本番 readiness G1–G7 の事前確認を完了し、必須安全ゲートをすべて満たす。30日運用テンプレートを使って指標を継続記録できる状態にし、実データ相当の backup / restore 演習を開始前に完了する。低リスク項目の未決だけは対象と期限・補償策・責任者を記録して扱えるが、必須安全ゲートは waiver で通過扱いにしない。

専用環境の provisioning を手動で始める場合も、実行者、承認、環境 ID、適用バージョン、backup 確認、終了・削除証跡を記録する。自動化は複数回の再現手順が安定してから行う。

## パイロット終了・一般提供判定

招待制パイロットは少なくとも30日間の運用証跡を蓄積してから評価する。終了時には本番 readiness G1–G7 と30日運用テンプレートを更新し、主要シナリオ成功率 95% 以上、人手介入 1 件 / 週以下、unknown error 10% 以下を確認する。未達値と低リスクの waiver は期限・補償策・責任者を明記して顧客レビューに提示する。必須安全ゲートの未達は waiver で補わず、一般提供を開始しない。

専用環境での一般提供へ進む条件は、これらの測定値、復元演習、顧客レビュー、契約・プライバシー確認を完了し、運用責任者と顧客責任者が go / no-go を記録することである。

## 共有ランタイムへ進む追加ゲート

共有環境は次をすべて満たすまで production 対象にしない。

1. **認証・認可**: 信頼できる IdP / session から viewer principal と tenant をサーバー側で解決する。クライアントの `tenant` / `tier` 指定は範囲を狭める用途だけに使い、デプロイ設定を `KYBERION_VIEWER_SCOPE=enforce` に固定する。
2. **データ・秘密の分離**: tenant scope を API、secure I/O、background job、cache、index、audit、export、backup の全経路で適用する。cross-tenant access は deny-by-default とし、brokered access だけを個別に監査する。鍵・secret、retention、削除を tenant 単位で管理する。
3. **実証された分離**: cross-tenant negative test、認可境界の fuzz / penetration test、同時実行時の context 混線試験、復元・削除試験に合格する。監査証跡から principal、tenant、操作、対象、結果を追跡できる。
4. **公平性と耐障害性**: tenant ごとの request / token / storage / concurrency quota と rate limit、noisy-neighbor 制御、circuit breaker、abuse 対応を設け、負荷試験と容量上限を記録する。
5. **顧客運用**: tenant の作成・停止・再開・export・削除、担当者変更、鍵 rotation、migration、upgrade rollback を制御面から再現可能にする。監視、SLO、on-call、incident 通知、DR drill を複数 tenant で検証する。
6. **独立レビュー**: threat model と残余リスクを更新し、顧客契約・データ所在地・subprocessor・保持期間の承認を完了する。専用環境のパイロット成功を共有環境の安全性の代用にしない。

## 現在把握している前提とギャップ

- [Multi-Tenant Operations](../../../knowledge/product/architecture/multi-tenant-operations.md) は tenant ごとの論理分離を定義している。そこに記載された HTTP viewer scope の段階移行、同一 host 上の論理境界、tenant rate limit などは、共有 SaaS の production gate として再評価する。
- [stance / tenant / customer model](../../../knowledge/product/architecture/stance-tenant-customer-model.md) の区別を保つ。顧客向け stance や tenant の顧客データを、Kyberion SaaS の tenant 境界と混同しない。
- 現在の production evidence 文書は記入用テンプレートであり、完了済みの30日運用証跡や復元演習が存在するとは扱わない。最初の design partner で実測値と未達項目を記録する。
- 2026-09-30 の doctor 診断では、`scripts/run_doctor.ts` が環境 probe 登録モジュールを import せず、一部 readiness 項目を「probe 未登録」と誤報していた。本変更で配線を修正する。doctor の表示改善は backup、secret、egress、顧客認証や本番契約の準備完了を意味しない。

## 実行順

1. **readiness 診断を正す** — probe 配線を修正し、build 後の `pnpm run doctor -- --json` で probe 結果を確認する。
2. **pilot brief を作る** — 最初の顧客候補、ユースケース、データ分類、地域、SLO、サポート、価格仮説、成功・停止条件を記録する。
3. **専用環境 runbook と証跡を完成する** — deploy / upgrade / rollback / backup / restore / incident / export / deletion の手順を検証する。
4. **招待制 pilot を実行する** — 顧客データ境界と同意範囲を限定し、30日間の信頼性・費用・介入を記録する。
5. **一般提供を判断する** — pilot の測定結果、契約レビュー、残余リスク、担当者の承認を根拠に dedicated SaaS の go / no-go を記録する。
6. **共有 runtime は再審査する** — dedicated 運用後に追加需要が確認できた場合だけ、共有テナントゲートを独立した計画・レビューとして起案する。

## 完了条件

- OSS / self-hosted と managed SaaS の責任境界が、ロードマップ、配布・運用文書、利用者向け契約説明で矛盾しない。
- SaaS の production go / no-go は、対象段階のゲート証跡と責任者の決定に結び付く。
- 専用環境パイロットの受入結果を記録し、共有ランタイムの実施可否を別判断として残す。
