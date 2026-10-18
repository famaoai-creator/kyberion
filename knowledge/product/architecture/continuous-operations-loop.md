---
title: 'Continuous Operations Loop'
tags: [architecture, organization, autonomy, continuous-operations]
last_updated: 2026-10-18
---

# 継続運営ループ

## 目的と計画

データを定期観測し、目標との差から仕事を棚卸しし、権限と予算の範囲で分配・実行・再観測する。ループは長寿命、仕事は有限とする。仕事を作らない周期も正常。

| 段階       | 実装                                          | 受入条件                                                       |
| ---------- | --------------------------------------------- | -------------------------------------------------------------- |
| 観測・分析 | scope 付き設定、数値 snapshot、閾値・鮮度検証 | 不正・古い・未来・別 scope の入力から分配しない                |
| 棚卸し     | 永続 episode、回復検知、cooldown、指標差分    | 同一問題を重複起票せず、再起動でも admission identity を維持   |
| 分配       | dot dispatch に pipeline proposal を渡す      | charter の scope / allowed_pipelines / 承認 / 予算を迂回しない |
| 実行・検証 | 既存 dot executor と outcome / KR を再利用    | claim・結果を追跡でき、次の観測で指標変化が見える              |
| 運用       | organization facade、定期 pipeline、dry-run   | 有効化前に候補・根拠・状態を確認できる                         |

## 契約と責任

信頼する設定が source path、metric、threshold、目標、実行 pipeline、担当 dot を指定する。観測データは metric / value / observed_at / evidence_ref のみを持ち、実行指示・scope・権限を指定できない。設定変更は通常の governed authoring / レビューで管理する。

外部サービス固有の取得は既存 tenant-ingest / connector、正規化は各データの adapter が担当する。初版の snapshot collector に加え、下記の内部指標と pipeline collector を接続する。任意 URL 取得・任意コード実行は追加しない。

scope は tenant → organization → project を一致させる。状態は同じ tier / tenant の runtime floor に保存する。棚卸しは rule ごとの episode で管理し、同一問題が継続している間は既存 admission を維持する。正常化の観測後の再発だけ cooldown を考慮して再提案する。稼働中の仕事の取消や担当の強制変更はしない。

- continuous loop: 目標との差、候補・根拠、重複抑制、前回指標との差分。
- dot dispatch: 権限、承認、予算、WorkItem admission。
- dot executor: claim、許可 pipeline 実行、結果、報告。
- dot feedback / KR: 実行成功と目標への効果の計測。
- organization operation / resident cadence: 周期と監視。
- work inventory: 仕事の方法・自動化適性の棚卸し。実行待ち WorkItem とは異なる。

## 初版の範囲と拡張計画

初版時点では既存 project の許可済み pipeline 分配を縦断実装する。この境界から下記の全経路接続へ拡張した。task_session 専用実行、進行中作業の強制中止、自由文による戦略再編は対象外。

意味分析を追加する場合も根拠付き候補を出す analyzer として接続し、モデル出力や外部文章から実行権限を作らない。

## 全経路の接続（2026-10-18）

初版の境界を拡張し、収集 → 分析 → episode → 承認 → WorkItem → 実行 → 成果物・指標の再観測を接続した。

| 経路                              | 実装と責任                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 収集                              | snapshot、組織 facade の集計指標、charter 許可済み pipeline collector。取得失敗・古い値・別 scope は分配前に拒否する。pipeline の完了時刻で鮮度を検証する。                                                                     |
| タスク                            | dot executor が既存 claim / lease の下で report pipeline を実行し、writeScopedArtifact でスコープ付き成果物を publish する。                                                                                                    |
| project / mission / mission_group | レビュー済み work_plan を immutable admission として保持する。必ず human approval を要求し、通常 worker からの実行を拒否する。                                                                                                  |
| lifecycle owner                   | mission owner 専用 port が governed project facade と mission_controller を子プロセスで実行する。project 作成、mission 作成、alignment approval、ticket import、bounded dispatch、phase gate、verify / distill を順に接続する。 |
| 進行                              | ミッションの依存関係を DAG として検証する。前段の検証済み完了を待って次へ進み、approval / paused / blocked / uncertain を保持する。                                                                                             |
| 再観測                            | admission、WorkItem、実行結果、成果物、project / mission の進捗を周期 report へ戻す。完了と指標改善は別々に観測する。                                                                                                           |
| 常駐                              | 既存 agent-runtime-supervisor の continuous step がレビュー済み schedule.every_seconds を処理する。新 daemon は作らない。                                                                                                       |

owner は各副作用の前に元の承認 hash・scope・charter・claim・lease を再確認する。期限超過・不確実な副作用は隔離し、同じ操作を自動再試行しない。機械による gate-pass は --machine-only を使い、stored gate の失敗・欠落・生の人間確認を拒否する。完了は全 task contract が completed かつ verification が verified の場合だけ返す。

組織運営用の organization-operations.json は既存 org-operations charter と同じ scope を使い、15分ごとに内部集計を観測する。レポートと判断待ち事項の project / mission 群を別ルールに分配する。通知は既存 charter の既定 inbox、実効果は既存 autonomy / approval gate に従う。

任意 SaaS の認証情報の追加、自由文からの権限生成、進行中の他 owner の強制取消は対象外。データ別 collector を追加する際も既存許可済み pipeline とスコープ付き snapshot の契約へ接続する。
