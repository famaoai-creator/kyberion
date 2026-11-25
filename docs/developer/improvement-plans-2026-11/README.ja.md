---
title: README
tags: [improvement-plan, 2026-11]
last_updated: 2026-11-22
status: active
---

# コードベース改善計画 2026-11

11月に起案・更新した計画の索引です。ドキュメント構成の正本は[ドキュメント索引](../../documentation-source-map.json)、全体の現況索引は[2026-08 索引](../improvement-plans-2026-08/README.ja.md)です。計画ごとの実装状況は各文書の `status` を正本とします。この索引は `concept-registry` ゲートが「月のフォルダの全計画を参照していること」を検査します。

## 情報資産とスコープ

- [情報資産のスコープモデル（管理・開示・加工）の設計](./INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md) — completed
- [保存先カタログと許可証による権限判定（tier-guard の再設計）](./STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md) — partial
- [情報資産カタログ・収集・dots intake 統合実装計画](./INFORMATION_ASSET_INTAKE_IMPLEMENTATION_PLAN_2026-11-02.ja.md) — completed

## 概念モデル v2 の移行

決定記録は [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) です。依存関係の順に並べています。

1. [スコープ・ID・権限（Grant）の統合計画](./SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md)（`partial`）。Stance の行動先選択、NHI の ID 形式、Member Role の型統合を反映済みです。Mission 起動時に `--org-role` を使えます。旧設定・旧 ID の互換読み込みと Authority Role の書き込み範囲の整理が残っています。
2. [WorkItem（Issue と子ステップ）と Lease の統合計画](./WORKITEM_ISSUE_LEASE_CONSOLIDATION_PLAN_2026-11-10.ja.md)（`completed`）。WorkItem が Issue を追跡し、担当を確保するステップは Lease を持つ子 WorkItem になります。Mission や Pipeline は Issue の実行方式です。
3. [意図の解決器の一本化計画](./INTENT_RESOLVER_UNIFICATION_PLAN_2026-11-10.ja.md)（`completed`）。各入口は共通の解決器が返す `RoutingDecision` と `ExecutionShape` を使います。
4. [記憶のループを閉じる計画](./MEMORY_LOOP_CLOSURE_PLAN_2026-11-10.ja.md)（`active`）。候補キューと昇格手順を統合し、直接 CLI 作業への配信と取得を確認済みです。直接 CLI 作業の利用報告を追加し、継続的に計測されることの確認が残っています。

利用者向けの定義は[基本概念](../../CORE_CONCEPTS.md)と[用語集](../../GLOSSARY.md)に反映しています。旧 Chronos の運用コンソールは Concierge の `/ops` へ移設済みです。[サーフェスマップ](../../SURFACES.md)に現行の入口と認可を記載しています。

外部操作の共通実行境界では、テナント照合と操作区分の検査を実装済みです。サービスのリソース検査は直接 API と対応する GitHub プリセットで実行対象を解決します。開示例外は内容と個別の HTTP(S) 宛先に結び付きます。未対応のサービスでの対象解決と、共通検査の警告モードから強制モードへの段階移行が残っています。[設計](../../../knowledge/product/architecture/scope-governance-plane.md) · [運用時の確認項目](../../OPERATOR_UX_GUIDE.md#authorization-and-disclosure-checks)

## 外部パターンの選択的採択

- [PiBot 選択的採択計画 (PB-00〜06)](./PIBOT_SELECTIVE_ADOPTION_PLAN_2026-11-22.ja.md) — active（#1563 Owner Grant continuity 上に実装。効果分析: [EFFECT_ANALYSIS](./PIBOT_SELECTIVE_ADOPTION_EFFECT_ANALYSIS_2026-11-22.ja.md)）

## 顧客とのやり取り

- [ヒアリングを 1 つの概念にまとめる計画 (HR-01〜05)](./HEARING_UNIFICATION_PLAN_2026-11-12.ja.md) — active

## 外部ホスト連携

- [VCS host API seam の設計 (gh CLI 依存の抽象化)](./VCS_HOST_API_SEAM_DESIGN_2026-11-04.ja.md) — completed
- [推論の資格情報の持ち主・種類・貸し出しと claude CLI の隔離（設計）](./CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16.ja.md) — active

## CLI・知覚動詞

- [kyberion read の URL 直接読み取り対応計画](./KYBERION_READ_URL_SUPPORT_PLAN_2026-11-25.ja.md) — completed（MSN-READ-URL-20261125 で実装。`read <url>` が secureFetch 経由で GET 取得し、リダイレクト各ホップも egress 再検証）

## 依存関係の変更記録

- [Lockfile 変更レビュー — @presence/mission-deck](./LOCKFILE_CHANGE_MISSION_DECK_2026-11-20.md) — completed
- [Lockfile 変更レビュー — web-tree-sitter と grammar パッケージ（code graph 抽出）](./LOCKFILE_CHANGE_CODE_GRAPH_2026-11-23.md) — completed
