---
title: Knowledge Management Standard (Semantic Indexing) v1.1
category: Standards
tags: [standards, knowledge, management]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-05
---

# Knowledge Management Standard (Semantic Indexing) v1.1

この文書は、Kyberion エコシステムにおけるナレッジファイルの構造化、インデックス管理、および**知的な取扱い（Intelligence Layer）**の標準を定義する。

## 1. Frontmatter 義務化

すべてのナレッジファイル（`.md`）は、冒頭に YAML Frontmatter を含めなければならない。

## 2. メタデータ・スキーマ

実際のコーパスで確立している規約に基づき、必須フィールドは `title`・`tags`・`last_updated` のみである（`AGENTS.md`「Place knowledge, don't paste it」参照）。その他のフィールドは用途に応じた任意のメタデータであり、すべての文書に要求しない。

| フィールド                                    | 必須 | 説明                                                                                      |
| :-------------------------------------------- | :--: | :---------------------------------------------------------------------------------------- |
| `title`                                       |  ○   | ドキュメントの正式名称。                                                                  |
| `tags`                                        |  ○   | カテゴリを横断するキーワード群（配列）。                                                  |
| `last_updated`                                |  ○   | YYYY-MM-DD 形式。                                                                         |
| `category`                                    |  ×   | コーパス内の大分類（`Standards`, `Orchestration`, `Connections` 等）。                    |
| `importance`                                  |  ×   | 1 〜 10 の重要度。`context_ranker` の加重に使用される。                                   |
| `author`                                      |  ×   | 作成者または作成ロール名。                                                                |
| `kind`                                        |  ×   | 文書種別。実在値: `evergreen`, `pattern`, `playbook`, `reference`, `sop_candidate` 等。   |
| `scope`                                       |  ×   | 適用範囲。実在値: `repository`, `global`。                                                |
| `authority`                                   |  ×   | 権威レベル。実在値: `standard`, `reference`, `policy`, `advisory` 等。                    |
| `phase` / `phase_affinity` / `runtime_stages` |  ×   | 適用ライフサイクルフェーズ（`onboarding`, `alignment`, `execution`, `review` 等）の配列。 |
| `role_affinity`                               |  ×   | この知識を特に重視すべきロール（配列）。`context_ranker` の Role Match に使用される。     |
| `owner` / `status`                            |  ×   | 管理責任ロール、および `active` 等の状態。                                                |

### 分類フィールド（任意）

以下のフィールドは §3「知的な取扱い基準」の枠組みを表現するための**任意**メタデータである。現行コーパスでは少数の文書のみが使用しており、必須ではない。

| フィールド           | 説明                                                                                          |
| :------------------- | :-------------------------------------------------------------------------------------------- |
| `knowledge_type`     | `explicit` (形式知: 事実・仕様) \| `tacit` (暗黙知: 美学・コツ)                               |
| `intelligence_layer` | `judgment` (判断基準) \| `procedure` (手順) \| `methodology` (調査手法)                       |
| `constraint_type`    | `regulation` (法) \| `standard` (業界基準) \| `specification` (仕様) \| `policy` (内部ルール) |
| `related_roles`      | `role_affinity` の旧称として一部の文書で使用。`context_ranker` は両方を読み取る。             |

## 3. 知的な取扱い基準 (Intelligence Handling)

| 分類                | エージェントの思考・行動規範                                            |
| :------------------ | :---------------------------------------------------------------------- |
| **`explicit`**      | RAG（検索）においてそのまま引用し、正確性を最優先する。                 |
| **`tacit`**         | 推論プロンプトに注入し、意思決定の「トーン」や「美学」として反映する。  |
| **`judgment`**      | トレードオフ発生時の「最終判断の根拠」として使用する。                  |
| **`procedure`**     | `Mission Logic Engine` のステップとして解釈し、自動化を試みる。         |
| **`regulation`**    | **絶対遵守制約**。違反の疑いがある場合は `Sudo Gate` で実行を停止する。 |
| **`specification`** | **唯一の真実 (SSoT)**。想像による補完を禁止し、定義に忠実に従う。       |

## 4. インデックス生成

...

ナレッジの追加・更新後は、必ず以下のコマンドを実行してインデックスを同期しなければならない。

```bash
pnpm generate:knowledge-index
```

## 5. ランキング・アルゴリズム

`context_ranker` は以下の要素を組み合わせてスコアリングを行う：

1.  **Intent Match**: インテント単語とタイトル・タグの一致。
2.  **Role Match**: アクティブなロールと `role_affinity`（旧称 `related_roles`）の一致。
3.  **Importance**: `importance` 値による加重。
4.  **Recency**: `last_updated` に基づく新しさの加味。

## 6. 自動メタデータ補完 (Auto-Enrichment)

...

- **Tags**: ディレクトリ名、ファイル名、および内容に含まれるプロトコル名。

## 7. ナレッジの輸出入 (Portability)

ナレッジベースの一部を他のエコシステムへ移管、または外部から取り込む際は、標準のインポート/エクスポートツールを使用しなければならない。

### エクスポート

外部エコシステム向けの共有は **public ティアを Git で同期**するのが正規ルートである（confidential/personal の持ち出しはティア隔離ポリシーで禁止）。

### インポート

```bash
pnpm knowledge:ingest --tenant <slug> --file <file> [--ocr]
```

ファイルが配置された後、`pnpm generate:knowledge-index` を実行してインデックスを同期する。
