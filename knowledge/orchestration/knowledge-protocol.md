# ハイブリッド・ナレッジ・プロトコル (3-Tier Sovereign Model)

本モノレポの全スキルが遵守すべき、ナレッジの階層構造と取り扱い基準。

## 1. ナレッジの階層 (Tier)

1. **Public Tier (`knowledge/`)**: 汎用基準。GitHub同期。
2. **Confidential Tier (`knowledge/confidential/`)**: 会社・プロジェクト共有の秘密。外部Git管理。
   - **Skill-Specific**: `.../skills/<skill-name>/`
   - **Client-Specific**: `.../clients/<client-name>/` (特定のクライアント固有の規約)
3. **Personal Tier (`knowledge/personal/`)**: 完全にローカル。**Git管理禁止**。個人の秘密鍵、APIキー、個人用メモ。

## 2. スキルの行動原則 (Core Logic)

- **優先順位 (Precedence)**: 同じ定義がある場合、以下の順で優先適用する。
  1. **Personal Tier** (個人の設定が最優先)
  2. **Confidential Tier (Client-Specific)** (クライアント固有設定)
  3. **Confidential Tier (Skill-Specific/General)** (会社標準)
  4. **Public Tier** (一般標準)
- **透過的参照**: 実行時、スキルは自動的に全 Tier を統合して最適なコンテキストを構築する。
- **機密保護 (Tier-Aware Output)**:
  - 外部公開物には Public Tier 以外の情報を直接含めてはならない。
  - Personal/Confidential 情報を利用した場合は、必ず「抽象化・匿名化」を行うこと。

## 3. クライアント・コンテキストの切り替え

- `mission-control` に対し「Client X として実行せよ」と命じることで、`knowledge/confidential/clients/ClientX/` がコンテキストの最上位にセットされる。
