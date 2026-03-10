# Ecosystem Initialization Protocol (Sovereign Onboarding) v2.1

この文書は、新規ユーザー（主権者）が Kyberion エコシステムに参加し、自律的なエージェント環境を物理的に起動し、自らの「魂」を注入するための全工程を定義する。

## 1. 概念的基盤 (The Soul)
初期化は、**「器（System）」の完成**と、その後の**「魂（Identity & Vision）」の注入**という二段階で構成される。器が完成していない状態での魂の注入は、情報の散逸（Directory Missing）を招くため、必ず物理的な安定化を先に行う。

## 2. セットアップ手順 (The 3-Stage Manifestation)

### Stage 1: Physical Foundation (pnpm install)
エコシステムを「休眠状態」から「活性化状態」へ移行させる。
- **Action**: `npx pnpm install` を実行する。
- **Effect**: 物理的な依存関係と、`workspace:` プロトコルによる内部リンクが確立される。

### Stage 2: System Manifestation (Orchestration Job)
ガバナンスに定義されたパイプラインを実行し、ディレクトリ構造の確立とビルドを完遂させる。
- **Action**: `npx tsx scripts/run_orchestration_job.ts` を実行する。
- **Effect**:
    - 全スキルのリンク再構築。
    - 全ワークスペースのビルド（`dist/` の生成）。
    - サービス群（`presence`）の起動。
    - これにより、`knowledge/personal/` を含む全ティアのディレクトリが物理的に保障される。

### Stage 3: Identity & Vision Infusion (Sovereign Concierge Hearing)
器が完成したエコシステムに、主権者の「意志」を宿す。
- **Action**: **Sovereign Concierge** ロールによるヒアリング対話を開始する。
- **Process**:
    - コンシェルジュが主権者の職業ドメイン、価値観、達成したいビジョンを問う。
    - 対話の結果に基づき、`knowledge/personal/my-identity.json` および `my-vision.md` を自動生成する。
    - これにより、エコシステムは「誰のために、何のために動くのか」を理解する。

## 3. Victory Condition
オンボーディングは、主権者がコンシェルジュとの対話を終え、`knowledge/personal/my-identity.json` が物理的に生成され、エコシステムが主権者の個性に適応（Alignment）した時点で完了とする。

---
*Signed,*
**Kyberion Ecosystem Architect**
