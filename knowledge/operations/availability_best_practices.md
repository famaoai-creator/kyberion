# Availability & Disaster Recovery Best Practices

システムの継続性を保証し、障害発生時にもサービスを維持・迅速に復旧させるためのガイドラインです。

## 1. 高可用性 (High Availability: HA) 設計

- **Eliminate SPOF (Single Point of Failure)**: すべてのレイヤー（DNS, Load Balancer, App, DB, Network）において冗長性を確保します。
- **Redundancy Models**:
  - **Active-Active**: 負荷分散しつつ、一方が落ちても他方で全トラフィックを処理可能にする。
  - **Active-Standby (Hot/Warm)**: 待機系を用意し、障害時に迅速に切り替える。
- **Multi-AZ Deployment**: 同一リージョン内の独立したデータセンター群（Availability Zones）に分散配置し、局所的な停電や故障に対応します。
- **Auto-Scaling & Health Checks**: インスタンスの不健全を検知して自動的に切り離し、必要に応じて新しいインスタンスを補充します。

## 2. 災害復旧 (Disaster Recovery: DR) 戦略

- **Key Metrics**:
  - **RTO (Recovery Time Objective)**: 障害発生から復旧までの目標時間。
  - **RPO (Recovery Point Objective)**: 許容できるデータ損失の目標時点。
- **DR Patterns**:
  - **Backup & Restore**: 定期バックアップから復旧（RTO/RPOは長いが低コスト）。
  - **Pilot Light**: 最小限の基盤（DB等）のみを常時稼働させ、有事に他を起動。
  - **Warm Standby**: 本番と同等の構成を縮小スケールで常時稼働。
  - **Multi-Site (Active-Active)**: 複数リージョンで常時全トラフィックを処理（RTO/RPOはほぼゼロだが高コスト）。
- **3-2-1 Backup Rule**:
  - 3つのコピーを保持。
  - 2つの異なるメディアに保存。
  - 1つはオフサイト（別リージョン等）に保管。

## 3. 非機能要求としての定義

- **Availability Tiers (IPA Grade 参考)**:
  - **Tier 1 (Critical)**: 99.99%以上、24/7稼働、RTO 1時間以内。
  - **Tier 2 (Standard)**: 99.9%以上、平日日中稼働、RTO 数時間〜1日。
  - **Tier 3 (Non-Critical)**: 95%以上、計画停止を広く許容。
- **Graceful Degradation**: 致命的な障害時でも、一部の機能（例: 閲覧のみ可能、決済のみ停止）を維持する設計を検討します。

## 4. 運用と検証

- **Failover Testing**: 意図的にプライマリを停止させ、セカンダリへの切り替えが正常に行われるか定期的に検証します。
- **Backup Integrity Check**: バックアップが取得されていることだけでなく、「実際にリストア可能か」を定期的にテストします。
- **Documentation**: 復旧手順書（Runbook）を整備し、誰でも対応可能な状態にします。
