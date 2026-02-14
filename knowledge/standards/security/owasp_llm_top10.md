# OWASP Top 10 for LLM Applications

生成AIエージェントを運用する上で防護すべき10の脆弱性と対策。

## 1. LLM01: Prompt Injection
- **概要**: 悪意のあるプロンプトでエージェントの指示（System Prompt）を上書きされる。
- **Gemini対策**: **Sovereign Token** によるツール実行権限の物理的な制約。

## 2. LLM02: Insecure Output Handling
- **概要**: AIの出力をそのままシステム命令として実行し、脆弱性を突かれる。
- **Gemini対策**: ティア制（Tier 1: Plan Mode）の導入により、AIの「考え」と「実行」を分離。

## 3. LLM06: Sensitive Information Disclosure
- **概要**: 出力に機密情報（PII, キー）が含まれてしまう。
- **Gemini対策**: `sensitivity-detector` スキルと **Quarantine（検疫所）** プロトコルの常時稼働。

## 4. LLM09: Overreliance (過度な依存)
- **概要**: AIの誤った回答を真実として受け入れてしまう。
- **Gemini対策**: **Shadow Execution** による複数AIの比較検証と、ACEによる合議。

---
*Reference: [OWASP Top 10 for LLM](https://owasp.org/www-project-top-10-for-large-language-model-applications/)*
