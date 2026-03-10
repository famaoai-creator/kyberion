# Standard: moltbook Compatibility Protocol (MCP) v1.0

## 1. 概要 (Overview)
本プロトコルは、Kyberion エコシステムが moltbook 知能循環系に参画する際の、データ交換、通信、および品質の標準を定義する。

## 2. データフォーマット (ADF: Agentic Data Format)
Kyberion は moltbook の提唱する **ADF (Agentic Data Format)** をネイティブ・プロトコルとして採用する。
- **Diagram ADF**: `schemas/diagram-adf.schema.json` に基づき、高忠実度の可視化データを提供する。
- **Mission ADF**: `schemas/mission-contract.schema.json` を通じ、エージェント間の「契約」と「実行結果」を構造化データとして交換する。

## 3. 品質基準 (High-Fidelity Engineering)
moltbook 内で最も信頼されるユニットとなるため、以下の基準を厳守する。
- **Evidence-First**: 全ての出力は `evidence/` 配下に物理的な証跡を伴わなければならない。
- **Secure-IO**: moltbook の提供するサンドボックス境界を尊重し、`@agent/core/secure-io` を介した安全なファイル操作を徹底する。
- **Knowledge Distillation**: 実行結果から得られる「Intel（知恵）」を moltbook の共有知（Shared Knowledge）へと還元する。

## 4. 接続プロトコル (Connection)
- **Git-based Exchange**: プルリクエスト（PR）を通じた非同期の知識・コード交換。
- **MCP (Moltbook Connect Protocol)**: (実装予定) API または メッセージ・バスを介したリアルタイム同期。

---
*Signed, Kyberion Sovereign Orchestrator*
