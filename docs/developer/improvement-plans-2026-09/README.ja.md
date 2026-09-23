---
title: README
tags: [improvement-plan, 2026-09]
last_updated: 2026-09-23
status: active
---

# コードベース改善計画 2026-09

9月に起案・更新した計画の索引です。ドキュメント構成の正本は[ドキュメント索引](../../documentation-source-map.json)です。計画ごとの実装状況は各文書を正本とします。8月から継続中の項目は[2026-08 索引](../improvement-plans-2026-08/README.ja.md)、完了済み計画は[2026-08 アーカイブ](../improvement-plans-archive/2026-08/README.ja.md)を参照してください。

## プロダクトと利用体験

- [フロントデスク再設計](./FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md) — 秘書室と相棒の共有レール、テナント表示、メンバーとアクターの境界を再設計。
- [ヒアリングとトレーニング](./FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md) — 依頼の要件化と、テナント単位の学習支援。
- [Local Pads 統合](./LOCAL_PADS_UNIFICATION_PLAN_2026-09-14.ja.md) — 8つの作業場所を共通の保存・履歴・UIへ統合。
- [業務棚卸しと実データ学習ループ](./WORK_INVENTORY_PLAN_2026-09-22.ja.md) — 業務観測、候補順位付け、実績による校正を計画。

## 実行基盤と運用

- [エージェント連携ビュー](./AGENT_COLLABORATION_VIEW_PLAN_2026-09-06.ja.md) — 既存イベントを使った連携ツリーと待ち状態の表示。
- [ミッションチーム編成の動的化](./TEAM_COMPOSITION_DYNAMICS_PLAN_2026-09-20.ja.md) — 義務から必要ロールを導き、需要に応じて充当する。
- [テナントナレッジと actuator 活用の評価](./TENANT_KNOWLEDGE_ACTUATOR_REVIEW_2026-09-11.ja.md) — 配置境界、computer-use の観測、受入検証の改善。

## 依存更新の証跡

- [pnpm lockfile review](./LOCKFILE_REVIEW_2026-09-10.ja.md) — 更新全体のレビュー記録。
- [安全な更新](./LOCKFILE_REVIEW_2026-09-10-dependency-safe-updates.ja.md) — パッチ・互換更新の証跡。
- [メジャー更新](./LOCKFILE_REVIEW_2026-09-10-dependency-major-updates.ja.md) — 破壊的変更を伴う更新の証跡。
- [セキュリティ更新 (2026-09-23)](./LOCKFILE_REVIEW_2026-09-23-security-updates.ja.md) — workspace 全体の77件の advisory を解消し、再監査で0件。
