# KM-03: 記憶昇格ガバナンスの閉ループ — distill の正規化・重複排除・陳腐化防衛

> 優先度: P1 / 規模: M / 依存: KM-01(ライフサイクル稼働) / 関連: [VOLATILE_KNOWLEDGE_PLAN](../../VOLATILE_KNOWLEDGE_PLAN.ja.md) Phase 4

## 背景と課題

「学習を統治された形でナレッジに昇格させる」ループが途中で切れており、しかも正しさの防衛が薄い。

- **distill が統治を迂回**: `pipelines/fragments/memory-distillation.json` は `system:write_artifact` で `knowledge/product/governance/HINTS.md` を**丸ごと直接上書き**する。VOLATILE_KNOWLEDGE_PLAN Phase 4(`:276`)が意図した promotion-queue 経由への置換(ecosystem roadmap も "must be replaced" と明記)が未実施。
- **昇格は手動のみ**: `memory-promotion-queue.ts` は積むだけで、消費は `mission_controller memory-promote <id>`(`scripts/mission_controller.ts:273-282`)の手動実行だけ。queued 候補を自動処理する仕組みが無く、「溜まるだけで参照されない」(`knowledge-index.ts:337` のコメントが警告する状態)。
- **重複排除ゼロ**: `enqueueMemoryPromotionCandidate` は JSONL に append するのみ(`memory-promotion-queue.ts:126-138`)。contentHash も重複チェックも無く、繰り返しミッションが同内容/矛盾内容の候補を積み続ける。
- **陳腐化・矛盾の防衛ゼロ**: 昇格時に「既存ナレッジと矛盾しないか」「既に同じ事実があるか」の検査が無い。ナレッジ側にも staleness 検出・supersede(置換)機構が無い(recency はランキングの重みに使われるだけ、`context_ranker.ts:314-317`)。
- 良い点(維持): 候補の provenance(`source_type`/`source_ref`/`evidence_refs`、`memory-promotion-queue.ts:24-38`)、public tier への機密参照混入ガード(`:66-76`)、tier≠personal の ratification 必須。

## ゴール(受入条件)

1. distill の出力が promotion queue を経由し、HINTS.md は「承認済み昇格の反映先」になる(直接上書きの廃止)。
2. 同一内容の候補は enqueue 時に dedup され(contentHash)、既出候補は occurrence カウント加算になる。
3. 昇格時に「類似既存ナレッジの提示 + 矛盾疑いの警告」が出る(自動棄却はしない。判断材料の提示まで)。
4. personal tier 向け候補は自動昇格でき(閾値付き)、それ以外は従来どおり ratification 必須。週次レビュー(KM-01 の weekly-review)が queued 候補の棚卸しを含む。
5. 昇格済みナレッジに supersede 関係(新しい事実が古い文書を置き換える)を記録できる。

## 実装タスク

### Task 1: distill 経路の付け替え — `claude-sonnet-4`

1. `memory-distillation.json` の sink を、`lessons_learned` を候補として `enqueueMemoryPromotionCandidate` に積む op(working-memory-actuator の `nominate-promotion` か、専用の薄い op)へ置換する。tier は原則 `product`(governance hints)で ratification 対象。
2. HINTS.md の更新は「承認済み候補の反映」ステップに変える: `memory-promotion-workflow` の promote 実行時、対象が hints 系なら HINTS.md の該当セクションに**追記**(全文上書きしない)。
3. 既存 HINTS.md(現状ヘッダのみ 8 行)の形式を「セクション = 昇格ID + 日付 + 本文 + source_ref」に定め、テンプレートを文書内コメントで示す。
4. E2E テスト: fixture trace → distill → queue に候補 → promote → HINTS.md に追記、の一連。

### Task 2: enqueue 時 dedup — `claude-sonnet-4`

1. `MemoryCandidate` に `content_hash`(正規化本文の sha256)を追加し、`enqueueMemoryPromotionCandidate` で既存 queued/promoted 候補との一致を検査。一致時は新規追加せず `occurrences` と `last_seen` を更新する(スキーマ拡張は `schemas/` の該当スキーマと同時に)。
2. 既存 JSONL との後方互換(hash 無しレコードは読める)を維持。unit test: 新規/重複/hash無し旧形式の 3 系。

### Task 3: 昇格時の類似・矛盾チェック — `claude-sonnet-4`

1. promote 実行時に `queryKnowledgeHybrid`(KM-02 の索引)で候補本文に類似する既存文書 top-3 を取得し、CLI に「類似既存ナレッジ」として提示する。
2. 矛盾疑いの判定は、reasoning backend が非 stub の場合のみ「候補と既存 top-1 は矛盾するか(yes/no/unrelated + 一文理由)」を 1 回問い合わせ、警告として表示する(stub 時はスキップし similar 提示のみ)。**自動棄却・自動書換はしない**。
3. 判定結果は候補レコードに記録し、監査可能にする。

### Task 4: 自動昇格(personal)と週次棚卸し — `claude-sonnet-4`

1. personal tier 向け候補のうち「dedup 済み・矛盾警告なし・`assessMissionMemoryCandidate` 適格」のものを自動 promote するモードを追加する(`KYBERION_MEMORY_AUTOPROMOTE=personal` でオプトイン。既定オフ)。
2. `weekly-review.json` パイプラインに「queued 候補の一覧と滞留日数を週次サマリへ出す」ステップを追加する(KM-01 で稼働済みの前提)。

### Task 5: supersede 記録 — `claude-haiku`

- 昇格ナレッジの frontmatter に `supersedes: <path or id>` フィールドを許可し、promote CLI に `--supersedes` オプションを追加。supersede された側の frontmatter に `superseded_by` を追記する(検索ランキングでの降格は KM-02 の共通スコアラーに 1 係数追加)。

## リスクと注意

- 自動昇格は「間違った事実の固定化」リスクと隣り合わせ。**既定オフ + personal tier 限定 + 矛盾警告なし条件**を外さない。confidential/public への自動昇格は実装しない。
- HINTS.md を追記型にするとファイルが伸び続ける。セクション数上限(例: 50)と、超過時は古いセクションを `knowledge/product/hints/archive/` へ退避する処理を Task 1 に含める。
- distill 経路の変更中も review フェーズが壊れないよう、旧 sink → 新 sink の切替は 1 コミットで行い、直後に E2E テストを走らせる。
