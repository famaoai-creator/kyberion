---
title: 'Continuous Operations Loop'
tags: [architecture, organization, autonomy, continuous-operations]
last_updated: 2026-11-22
concepts:
  [
    organization-work-loop,
    mission,
    work-item,
    pipeline,
    dot,
    delivery,
    factory-delivery-envelope,
    outcome,
    evidence,
    organization,
    tenant,
  ]
---

# 継続運営ループ

## 目的と計画

このループは [Organization Work Loop](organization-work-loop.md)（親モデル）の常駐運用プロジェクションであり、独立した状態機械ではない。データを定期観測し、目標との差から仕事を棚卸しし、権限と予算の範囲で分配・実行・再観測する。ループは長寿命、仕事は有限とする。仕事を作らない周期も正常。

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

組織運営用の organization-operations.json は、tenant に導入した org-operations charter（[テンプレート](../orchestration/dot-team-templates/org-operations.json)から `dot create` したもの）と同じ dot_id・scope を宣言し、15分ごとに内部集計を観測する。sweep は dot_id と scope が完全一致する active charter がある環境でだけこの設定を実行し、一致しない環境では何もしない。設定の scope は現状 1 tenant に固定されており、他の tenant で使うには同じディレクトリにその tenant 用のレビュー済み設定を追加する。レポートと判断待ち事項の project / mission 群を別ルールに分配する。通知は既存 charter の既定 inbox、実効果は既存 autonomy / approval gate に従う。

任意 SaaS の認証情報の追加、自由文からの権限生成、進行中の他 owner の強制取消は対象外。データ別 collector を追加する際も既存許可済み pipeline とスコープ付き snapshot の契約へ接続する。

## 再評価トリガー条件（既定: 助言 / opt-in で監視ルール化）

精度や前提条件が時間とともに変化する AI 適用業務では、継続観測から再評価へ繋ぐ以下の 7 トリガーを監視候補として扱う（[ai-requirements-governance-playbook.md](../orchestration/ai-requirements-governance-playbook.md) §4）。

1. **精度・KR ドリフト**: 目標指標や成果判定の連続劣化
2. **入力分布・OOD 変化**: 想定外入力や未マッピング入力比率の上昇
3. **苦情・手戻り閾値超過**: 再作業 WorkItem や差し戻し率の増加
4. **法規制・社内規定改定**: 外部規範やテナント方針の更新
5. **モデル・プロンプト・知識更新**: 推論バックエンドや中核ナレッジの変更
6. **外部 API・SLA 変更**: 依存先サービスの仕様・制限・応答品質の変化
7. **監査指摘・重大インシデント**: セキュリティ／コンプライアンス指摘または障害発生

これらはテナント・組織の監視設定で明示的に **opt-in** された場合にだけ自動起票・再評価ルールとして有効化し、既定では助言候補の提示にとどめる（既存の進行中作業を強制取消しない原則・lease 契約は維持する）。

## Software Factory 自律基盤（Track 1: 並列ブランチ・封筒・opt-in 段階昇格）

既定動作（`agent/kyberion-development` 単一ブランチおよび全 `shadow: true` アクション停止）を保ったまま、ミッション単位で完結・検証・収束できる基盤を段階導入する。

- **ミッション単位の並列開発ブランチ**: `libs/core/vcs/development-branch.ts` により、従来の `agent/kyberion-development` に加えて `agent/factory-<slug>`（`^agent/factory-[a-z0-9][a-z0-9-]{1,60}$`）を許可し、複数ミッションを相互干渉なく並列実行できるようにした。
- **テナント別 opt-in shadow 昇格ポリシー**: 公開カタログ `knowledge/product/governance/factory-autonomy-policy.json`（常に既定 `"tenants": {}`）を土台に、`knowledge/confidential/<tenant-slug>/governance/factory-autonomy-policy.json` の tenant governance overlay（自テナント専用スコープに厳格限定）を `libs/core/governance/factory-policy.ts` がマージし、明示的に有効化されたテナントかつ許可済みアクション（`mission_start_mandate`、`ci_autofix_attempt`、`main_sync_clean`、`conflict_mechanical`、`pr_merge_low`、`pr_merge_medium`、`auto_revert_on_main_failure`）だけ shadow を解除する。`high_risk_paths` / `never_auto` / スコア上限による人間承認エスカレーションは常に維持する。
- **不変 Delivery Envelope と差分検証**: `libs/core/governance/factory-delivery-envelope.ts` が Standing Mandate または承認済み Alignment Brief に紐づく SHA-256 署名付き `FactoryDeliveryEnvelope` を生成し、`high_risk_paths`・`scope_out`・`allowed_paths` 逸脱および低リスク自動マージの安全側縮小（`auto_low_risk` → `veto_window`）を強制する。
- **導入診断 (`evaluateFactoryReadiness`)**: `libs/core/governance/factory-readiness.ts` が halt 状態・テナント opt-in・有効な Standing Mandate 件数・各ゲート判定を統合し、有効化前のブロッカーを一覧化する。

## Software Factory 自律基盤（Track 2: 有界 CI 自動修復・機械的 main 同期分類）

PR 作成後の CI 失敗・ベースブランチ追従に対して、無制限ループや規約回避を防ぎつつ回復を自動化する境界を定義した。

- **有界 CI 自動修復計画 (`libs/core/governance/factory-ci-autofix.ts`)**: `planFactoryCiAutofix` が失敗クラス（`generated-drift` / `test-failure` / `gate-failure` / `infra` / `ratchet/registration` / `platform` / `unknown`）と最大 3 回の試行上限、`priorSignatures` による同一失敗署名での即時停止、`ci_autofix_attempt` の opt-in 昇格ゲートを統合評価する。`validateCiAutofixPatchGuard` はベースライン・設定変更や `.skip()` / `// @ts-ignore` / アサーション削除を検出して `approve` へ引き戻す。
- **読み取り専用 `git merge-tree` による main 同期分類 (`libs/core/vcs/factory-branch-sync.ts`)**: `git-probe-hardening.ts` に厳格な 6 引数の `merge-tree --write-tree --name-only --no-messages` 文法を追加し、`clean`（無競合）・`mechanical`（生成物のみ競合、`pnpm kyberion resolve generated` 対象）・`semantic`（コード・`high_risk_paths`・設定競合は即エスカレーション）を非破壊に判定する。
- **`mission-development-continuation.ts` 統合**: `factory_envelope` が付与された開発仕様では、CI 失敗時に `ci_failure_signatures` を永続化しつつ `assessFactoryBranchMainSync` および `planFactoryCiAutofix` を実行し、自動修復・待機・人間エスカレーションを決定論的に振り分ける。

## Software Factory 自律基盤（Track 3: リスク段階マージ・Veto 窓・1-Shot 承認委任・自動リバートと収束）

PR 作成・CI 合格・独立レビュー完了後のマージ判断と、マージ後インシデント復旧・ワークツリー収束までをリスク段階に応じて完結させる。

- **1-Shot Alignment Brief 委任 (`knowledge/product/schemas/mission-brief.schema.json`, `libs/core/governance/factory-delivery-envelope.ts`)**: `mission-brief.json` に任意フィールド `factoryDelivery`（`enabled` / `branch` / `mergeMode` / `maxCiRepairAttempts` / `allowedPaths`）を追加し、承認ハッシュ (`payloadHash`) と承認 UI 開示 (`formatFactoryDelivery`) に束縛する。`createFactoryEnvelopeFromAlignedBrief` が承認済みブリーフから署名付き `FactoryDeliveryEnvelope` を構築する。
- **リスク段階マージ & Veto 窓 (`libs/core/governance/factory-merge-gate.ts`)**: `evaluateFactoryMergeGate` が停止スイッチ・封筒境界・CI 緑・独立レビュー・修復上限・PR リスク層を検証し、低リスク（`pr_merge_low` 昇格時のみ）を自動マージ、中リスク（`pr_merge_medium` 昇格時）を 120 分 fail-closed Veto 窓（配信猶予・稼働時間・異議・未配信エスカレーション）で処理し、高リスク・シャドウ・`never_auto`・修復上限到達は常に人間承認（`human_only`）へ引き戻す。
- **マージ後自動リバートと収束 (`libs/core/governance/factory-post-merge.ts`)**: `planFactoryPostMergeRevert` は `main` CI 再実行再現を前提に 1 インシデント 1 回限りの `agent/factory-revert-<sha>` リバート PR を計画し、必要に応じて `autonomy-action-state` でマージ自律レベルを即時降格する（競合・`high_risk_paths`・シャドウ時は人間エスカレーション）。`buildFactoryConvergencePlan` はミッション終端状態と不変マージコミット検証を確認した上で `main` 同期・ワークツリー削除・`agent/factory-*` ブランチ削除手順を組み立て、非終端ミッションの台帳（`active/missions/`）保護を強制する。
- **継続開発ループ統合 (`libs/core/mission/mission-development-continuation.ts`)**: `factory_envelope` 付与時は `reconcile` 前に `evaluateFactoryMergeGate` と `factory_veto_window` 永続化を強制し、`merged` 時に `factory_convergence_plan` を、`post_merge_failed` 時に `factory_revert_plan` を返す。
