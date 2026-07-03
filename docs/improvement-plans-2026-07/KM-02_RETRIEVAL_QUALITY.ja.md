# KM-02: ナレッジ検索品質 — 本文埋め込みと「偽セマンティック」の解消

> 優先度: P1 / 規模: M / 依存: KM-04(汚染除去を先に)推奨

## 背景と課題

検索基盤(RRF ハイブリッド)は設計として健全だが、**入力素材と埋め込みバックエンドの2点で品質上限が低い**。

- **本文が一切埋め込まれていない**: `libs/core/src/knowledge-index.ts` の埋め込み対象は `topic + tags + hint の先頭300字`(`:575-577`)で、hint 自体もタイトル+先頭段落200字(`:507-510`)。約877本のナレッジ文書の**本文は semantic にも lexical にも見えていない**。
- **非 Mac では「セマンティック」が偽物**: 実埋め込みは MLX `multilingual-e5-large-instruct`(1024次元)で **Apple Silicon 専用**(`libs/core/mlx-embedding-backend.ts:86-89`)。それ以外(CI・Linux)は 64 次元 FNV ハッシュバケット(`libs/core/embedding-backend.ts:8,28-51`)に**無言でフォールバック**する。ハッシュは字面一致の近似であり意味検索ではないのに、コードパスは「hybrid semantic」を名乗る。
- **ランカーが2系統併存**: `scripts/context_ranker.ts`(406行、frontmatter メタデータ+substring スコア)と `knowledge-index.ts`(718行、スコープ対応ハイブリッド)。コーパスもスコアも別物で、片方の改善がもう片方に効かない。
- 良い点(維持する): スコープハッシュでキャッシュを tier 分離(`knowledge-index.ts:122-140`)、RRF フュージョン(`:626-703`)、embedding 無し時の lexical 縮退。

## ゴール(受入条件)

1. ナレッジ文書の**本文**がチャンク分割されて埋め込み/索引され、本文にしか無い語・概念での検索が当たる(before/after の検索品質比較で確認)。
2. ハッシュ埋め込みで動作している場合、その事実が起動ログ・doctor・検索結果メタに明示される(「semantic 検索は縮退モード」)。
3. 非 Mac 環境向けの実埋め込み経路が 1 つ用意される(候補: ONNX ランタイムの多言語 E5 小型モデル / 既存 reasoning backend の embedding API。選定は Task 3)。
4. ランカー2系統の統合方針が決まり、少なくともスコアリング定義が共通モジュールに寄る。

## 実装タスク

### Task 1: 本文チャンク索引 — `claude-sonnet-4`

1. `knowledge-index.ts` の索引構築(`_scanProductTier` 等)に、本文のチャンク化(目安: 800〜1200字、見出し境界優先、overlap 100字)を追加する。チャンクは `docId#chunkN` として親文書メタ(tier/scope/tags)を継承する。
2. 埋め込みキャッシュ(`active/shared/cache/ki-*.json`)の容量増に備え、(a) チャンク埋め込みは文書の contentHash 単位で差分更新、(b) キャッシュ上限とLRU破棄、を入れる。
3. 検索結果は文書単位に集約(最良チャンクのスコア + チャンク位置)して返し、既存の呼び出し契約(`queryKnowledgeHybrid` の戻り型)を壊さない(フィールド追加のみ)。
4. 評価: 代表クエリ 20 本(本文にのみ答えがあるもの 10 本を含む)の before/after 命中率を fixture 化し、テストとして残す。

### Task 2: 縮退モードの可視化 — `claude-haiku`

- `embedding-bootstrap` がハッシュフォールバックを選んだ場合: 起動ログ(既に INFO はある)に加えて、(a) doctor / dashboard の能力サマリ(AC-01 Task 3)に「semantic 検索: 縮退(hash)」を表示、(b) `queryKnowledgeHybrid` の結果メタに `embedding_backend: 'mlx' | 'local-hash'` を含める。

### Task 3: 非 Mac 実埋め込み経路の選定と実装 — `claude-sonnet-4`

1. 候補比較(1〜2時間の調査を先行): (a) `onnxruntime-node` + multilingual-e5-small(依存増・オフライン可)、(b) Anthropic/外部 API の embedding(依存小・ネットワークとコスト前提)、(c) 現状維持で「Mac 以外は lexical のみ」と正直に宣言。**判断基準は「30日運用マシンが Mac か否か」**— 現運用が Mac 中心なら (c)+Task 2 で十分、Linux 展開予定があれば (a)。比較表を本文書に追記し推奨を明記、実装は推奨案のみ。
2. 選定案を `embedding-bootstrap` の backend 候補に追加し、`KYBERION_EMBEDDING_BACKEND` で明示選択可能にする。

### Task 4: ランカー統合(第一歩)— `claude-sonnet-4`

1. `context_ranker.ts` の役割(パイプライン向けの文書ランキング CLI)と `knowledge-index.ts`(ランタイム検索)の呼び出し元を整理し、スコアリング(recency 減衰・authority・scope 適合)を `libs/core` の共通モジュールに抽出して両者から使う。
2. 完全統合(context_ranker を knowledge-index の CLI ラッパーにする)は影響範囲を調査した上で「次の一手」として本文書に追記するに留める(本 IP では共通化まで)。

## リスクと注意

- チャンク索引はコーパス約877文書 × 数チャンクの埋め込み計算が初回に走る。MLX での初回構築時間を計測し、5 分を超えるならバックグラウンド構築(検索は lexical で先行応答)にする。
- KM-04 のテスト汚染(1,387 ファイル)を先に除去しないと、索引構築時間とキャッシュを無駄に食う。実施順は KM-04 → KM-02 を推奨。
- 埋め込みバックエンドを変えると既存キャッシュと非互換になる。キャッシュキーに backend 識別子を含める(スコープハッシュへの追加)。
