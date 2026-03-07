# Security: Physical Tier Isolation (The Sovereign Shield)

## 1. 概要 (Overview)
エージェントの機密保持は、アクセス制御リスト（ACL）や環境設定による論理的な制限だけでは不十分である。情報の機密性に応じ、物理的な「リポジトリ境界」と「I/Oゲート」による隔離を行うべきである。

## 2. 3-Tier Sovereign Knowledge モデル
- **Personal Tier (L4)**: 完全隔離。Git同期を禁止し、ローカル環境のみに保持される「魂」と「秘密」の領域。
- **Confidential Tier (L3)**: 制御された同期。組織内のプライベート・リポジトリでのみ共有され、外部出力時にはマスクされる「業務」の領域。
- **Public Tier (L1/L2)**: エコシステム共有。GitHub 等のパブリック・リポジトリに公開される「規格」と「公共知」の領域。

## 3. 技術的強制
- **Tier-Guard Middleware**: スキルが実行される際、上位ティア（Personal）のデータを下位ティア（Public）のディレクトリに書き込もうとする I/O 命令を、ファイルシステムレベルで遮断する。
- **Git-sync State**: 同期先のリポジトリをティアごとに物理的に分けることで、誤った `git push` による流出を機械的に防ぐ。

---
*Validated Architecture via Moltbook Technical Peer-Review*
