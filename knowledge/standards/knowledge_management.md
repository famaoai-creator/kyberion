---
title: Knowledge Management Standard (Semantic Indexing) v1.0
category: Standards
tags: [standards, knowledge, management]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---
# Knowledge Management Standard (Semantic Indexing) v1.1

この文書は、Kyberion エコシステムにおけるナレッジファイルの構造化、インデックス管理、および**知的な取扱い（Intelligence Layer）**の標準を定義する。

## 1. Frontmatter 義務化
すべてのナレッジファイル（`.md`）は、冒頭に YAML Frontmatter を含めなければならない。

## 2. メタデータ・スキーマ (拡張版)

| フィールド | 必須 | 説明 |
| :--- | :---: | :--- |
| `title` | ○ | ドキュメントの正式名称。 |
| `knowledge_type` | ○ | `explicit` (形式知: 事実・仕様) \| `tacit` (暗黙知: 美学・コツ) |
| `intelligence_layer` | ○ | `judgment` (判断基準) \| `procedure` (手順) \| `methodology` (調査手法) |
| `constraint_type` | × | `regulation` (法) \| `standard` (業界基準) \| `specification` (仕様) \| `policy` (内部ルール) |
| `importance` | ○ | 1 〜 10 の重要度。 |
| `tags` | ○ | カテゴリを横断するキーワード群（配列）。 |
| `related_roles` | × | この知識を特に重視すべきロール（配列）。 |
| `last_updated` | ○ | YYYY-MM-DD 形式。 |

## 3. 知的な取扱い基準 (Intelligence Handling)

| 分類 | エージェントの思考・行動規範 |
| :--- | :--- |
| **`explicit`** | RAG（検索）においてそのまま引用し、正確性を最優先する。 |
| **`tacit`** | 推論プロンプトに注入し、意思決定の「トーン」や「美学」として反映する。 |
| **`judgment`** | トレードオフ発生時の「最終判断の根拠」として使用する。 |
| **`procedure`** | `Mission Logic Engine` のステップとして解釈し、自動化を試みる。 |
| **`regulation`** | **絶対遵守制約**。違反の疑いがある場合は `Sudo Gate` で実行を停止する。 |
| **`specification`** | **唯一の真実 (SSoT)**。想像による補完を禁止し、定義に忠実に従う。 |

## 4. インデックス生成
...

ナレッジの追加・更新後は、必ず以下のコマンドを実行してインデックスを同期しなければならない。
```bash
npm run generate-index
```

## 4. ランキング・アルゴリズム
`context_ranker` は以下の要素を組み合わせてスコアリングを行う：
1.  **Intent Match**: インテント単語とタイトル・タグの一致。
2.  **Role Match**: アクティブなロールと `related_roles` の一致。
3.  **Importance**: `importance` 値による加重。
4.  **Recency**: `last_updated` に基づく新しさの加味。

## 5. 自動メタデータ補完 (Auto-Enrichment)
...
- **Tags**: ディレクトリ名、ファイル名、および内容に含まれるプロトコル名。

## 6. ナレッジの輸出入 (Portability)
ナレッジベースの一部を他のエコシステムへ移管、または外部から取り込む際は、標準のインポート/エクスポートツールを使用しなければならない。

### エクスポート
```bash
npx tsx scripts/export_knowledge.ts <category>
```
`hub/exports/` に KEP (Knowledge Exchange Package) ファイルが生成される。

### インポート
```bash
npx tsx scripts/import_knowledge.ts <path-to-kep-file>
```
ファイルが配置され、自動的に `npm run generate-index` が実行される。
