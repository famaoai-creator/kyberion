# prompts/
AI Architect 監修：プロンプト・エンジニアリング資産

## 1. External Best Practices
- **Chain-of-Thought (CoT)**: "Let's think step by step" を基本とし、複雑な論理展開を強制する (OpenAI).
- **Few-Shot Prompting**: 期待する JSON 形式に対して最低 3 つの入出力例を提示し、ハルシネーションを抑制する.
- **XML Tagging**: コンテキスト、命令、出力を `<instruction>` 等のタグで分離し、解析精度を高める (Anthropic).

## 2. Token Economy
- **Truncation Strategy**: 過去履歴の 20% を保持し、残りを「意味的要約（Semantic Summary）」に圧縮する.
- **Model Routing**: 判定は Pro、単純な変換は Flash というコスト最適化ルーティングの適用.
