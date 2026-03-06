# Knowledge Management Standard (Semantic Indexing) v1.0

この文書は、Kyberion エコシステムにおけるナレッジファイルの構造化およびインデックス管理の標準を定義する。

## 1. Frontmatter 義務化
すべてのナレッジファイル（`.md`）は、冒頭に YAML Frontmatter を含めなければならない。これにより、エージェントが `context_ranker` を通じて適切に知識を選択可能になる。

## 2. メタデータ・スキーマ

| フィールド | 必須 | 説明 |
| :--- | :---: | :--- |
| `title` | ○ | ドキュメントの正式名称。 |
| `category` | × | 分類カテゴリ。ディレクトリ名と一致させることが推奨される。 |
| `tags` | ○ | カテゴリを横断するキーワード群（配列）。 |
| `importance` | ○ | 1（参考）〜 10（憲法・最優先）の重要度。 |
| `related_roles` | × | この知識を特に重視すべきロール（配列）。 |
| `scope` | × | `global`, `project`, `internal` 等の適用範囲。 |
| `last_updated` | ○ | YYYY-MM-DD 形式の最終更新日。 |

## 3. インデックス生成
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
