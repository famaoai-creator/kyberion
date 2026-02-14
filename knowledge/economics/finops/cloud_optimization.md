# Cloud FinOps & Unit Economics Standard

技術的選択を「コスト効率」と「利益率」の観点から最適化するための基準。

## 1. ユニットエコノミクス (Unit Economics)
システムのスケーラビリティを「利益が出るか」で判定する計算モデル。

- **LTV/CAC > 3x**: 顧客生涯価値が獲得コストの3倍以上であること。
- **Cost Per Request (CPR)**: 1リクエストあたりのインフラコストをミリ秒単位で計測。
- **ACEへの適用**: CPR が目標値を超過するアーキテクチャ変更は、SREではなく FinOps ロールが NO-GO を出す。

## 2. クラウドコスト最適化 (Cloud Optimization Patterns)
- **Spot Instances**: ステートレスな処理（Pulse Dispatcher等）は、最大90%OFFのスポットインスタンスで実行する。
- **Reserved / Savings Plans**: 24時間稼働の基盤（Database, API Gateway）は、1年/3年の確約契約を結ぶ。
- **Right Sizing**: `cloud-waste-hunter` スキルを使い、CPU/メモリ使用率が30%未満のリソースを自動縮小する。

## 3. タグ付け戦略 (Cost Allocation)
- 全てのリソースに `Project`, `Environment`, `Owner` タグを強制し、コストの帰属（Showback/Chargeback）を明確にする。

---
*Created: 2026-02-14 | Capital Strategist*
