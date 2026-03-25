# Engine Refinement Roadmap

エコシステムの次の抽象化レベルへの引き上げ。6つの柱を順に実装する。

## Status Legend
- [ ] Not Started
- [~] In Progress
- [x] Done

---

## Phase 1: Pipeline Composability

パイプラインの合成可能性。フラットなステップ配列から、参照・再利用・エラーハンドリングを備えた宣言的パイプラインへ。

### Tasks

- [x] **1.1** `PipelineRef` 型の定義 — `OnErrorConfig`, `RefParams` in `libs/core/src/pipeline-engine.ts`
- [x] **1.2** パイプラインローダー — `resolveRef()` with depth tracking (max 10), `handleStepError()` with skip/abort/fallback
- [x] **1.3** browser-actuator の `control` ステップに `ref` op を追加 + `on_error` handling in catch blocks
- [x] **1.4** media-actuator にも同様の `ref` op + `on_error` を追加
- [x] **1.5** `on_error` ハンドラー — `handleStepError()` with inline fallback or ref-based fallback
- [x] **1.6** 共通サブパイプライン作成 — `pipelines/fragments/intra-login.json`, `ringi-approve-single.json`
- [ ] **1.7** `intra_ringi.adf.json` を composable 形式にリファクタ

### Acceptance Criteria
- 既存のフラットパイプラインが壊れない（後方互換）
- サブパイプライン参照でネスト 3 段まで動作
- on_error でリカバリーパイプラインが実行される
- 稟議シナリオがサブパイプライン参照で動作

---

## Phase 2: Reactive Knowledge

Knowledge 層を受動的なファイル群から、actuator が実行時に参照できる能動的な知識基盤へ。

### Tasks

- [x] **2.1** `KnowledgeQuery` インターフェース定義 — `query(topic: string, context?: { actuator?: string, op?: string }): KnowledgeHint[]`
- [x] **2.2** `knowledge-index.ts` — knowledge/public 配下のドキュメントをインデックス化（タイトル、タグ、要約のフラットインデックス）
- [x] **2.3** `wisdom-actuator` に `query` op を追加 — セマンティック検索ではなくキーワード + パスベースの軽量マッチング
- [x] **2.4** `KnowledgeHint` 型 — `{ topic: string, hint: string, source: string, confidence: number }`
- [ ] **2.5** browser-actuator の `goto` / `fill` / `click` 前に knowledge 参照を挟む hook ポイント（opt-in）
- [ ] **2.6** distill フェーズで学習した知見を `knowledge/public/procedures/hints/` に構造化出力
- [ ] **2.7** 稟議シナリオの学習結果（セレクタ、フロー）を hint として保存し、次回実行時に自動参照されるデモ

### Acceptance Criteria
- actuator が knowledge.query() でヒントを取得できる
- distill で出力された hint が次の Mission で参照される
- パフォーマンス: query は 10ms 以内（ファイルスキャンではなくインデックス参照）

---

## Phase 3: Design Protocol の汎化

PPTX/XLSX 個別の DesignProtocol を汎用 `DocumentDesignProtocol<T>` に昇格。

### Tasks

- [x] **3.1** `DocumentDesignProtocol<T>` ジェネリック型定義 — semantic, rawParts, provenance の 3 層
- [ ] **3.2** `PptxDesignProtocol` を `DocumentDesignProtocol<PptxSemantic>` の特殊化としてリファクタ
- [ ] **3.3** `XlsxDesignProtocol` を同様にリファクタ
- [ ] **3.4** `DocxDesignProtocol` を同様にリファクタ（docx-utils.ts の distillDocxDesign を整合）
- [x] **3.5** `Provenance` 型 — `{ sourceFile?: string, extractedAt: string, transformHistory: TransformStep[] }`
- [ ] **3.6** 異フォーマット間変換の基盤 — `convertDesign(source: DocumentDesignProtocol<A>, target: 'pptx' | 'xlsx' | 'docx'): DocumentDesignProtocol<B>`
- [x] **3.7** セマンティック差分検出の汎用化 — `diffDesign(a: DocumentDesignProtocol<T>, b: DocumentDesignProtocol<T>): DesignDelta[]`

### Acceptance Criteria
- 既存の PptxDesignProtocol / XlsxDesignProtocol の全機能が維持される
- 新しい型が media-actuator の extract/render パスで使える
- provenance が変換履歴を追跡

---

## Phase 4: Actuator Capability Contract の動的化

静的マニフェストから実行時ケイパビリティ検出へ。

### Tasks

- [x] **4.1** `ActuatorCapability` 型定義 — `{ op, available, reason, prerequisites, cost }`
- [x] **4.2** `checkCapabilities()` 関数を各 actuator に実装するための基底インターフェース `IActuatorCapabilityCheck`
- [x] **4.3** browser-actuator: Playwright インストール有無の検出
- [x] **4.4** voice-actuator: Style-Bert-VITS2 サーバー稼働状態の検出
- [x] **4.5** network-actuator: VPN / イントラネット到達性の検出
- [x] **4.6** `cli.ts` の `list` コマンドに `--check` オプション追加 — 実行時 capability を表示
- [ ] **4.7** orchestrator-actuator が capability を考慮した actuator 選択を行う

### Acceptance Criteria
- `pnpm cli list --check` で各 actuator の実行時状態が表示される
- Playwright 未インストール時に browser-actuator が `available: false, reason: "playwright not installed"` を返す
- orchestrator が capability に基づいてフォールバックルーティングできる

---

## Phase 5: Observability の統一モデル

分散したログ・メトリクス・エビデンスを統一的な Trace Model に統合。

### Tasks

- [x] **5.1** `Trace` / `Span` / `Event` 型定義 — OpenTelemetry 互換 + artifact / knowledge_ref 拡張
- [x] **5.2** `TraceContext` — パイプライン実行時に自動的に span を開始/終了するコンテキストオブジェクト
- [ ] **5.3** browser-actuator の `action_trail` を Trace 形式に移行
- [ ] **5.4** media-actuator のパイプラインログを Trace 形式に移行
- [ ] **5.5** mission_controller の checkpoint/evidence を Trace に統合
- [ ] **5.6** `artifact` タイプ — スクリーンショット、生成ファイルを Trace 内に参照として保持
- [ ] **5.7** Chronos Mirror v2 に Trace ビューア追加 — Mission 単位でのスパンツリー表示
- [ ] **5.8** distill フェーズが Trace データから自動的にサマリーを生成

### Acceptance Criteria
- 全 actuator のパイプライン実行が統一 Trace 形式で記録される
- Trace に correlation ID があり、Mission → Pipeline → Step の階層が追跡可能
- Chronos で Trace を視覚的に確認できる

---

## Phase 6: Tier Isolation のマルチテナント拡張

単一 Sovereign モデルからプロジェクト/クライアント別の分離へ。

### Tasks

- [x] **6.1** `TierScope` 型定義 — `{ tier: 'personal' | 'confidential' | 'public', project?: string, client?: string }`
- [x] **6.2** `tier-guard.ts` にプロジェクトスコープ対応追加 — `confidential/{project}/` パスの認可ルール
- [x] **6.3** `security-policy.json` にプロジェクト別パーミッション設定の拡張
- [ ] **6.4** Mission 作成時にプロジェクトスコープを指定可能にする — `pnpm mission start TASK-01 confidential --project canton-node`
- [ ] **6.5** knowledge sync でプロジェクト間の分離を検証するテスト
- [ ] **6.6** ドキュメント: マルチプロジェクト運用ガイド

### Acceptance Criteria
- `confidential/canton-node/` と `confidential/client-a/` が物理的に分離される
- プロジェクトスコープ外のファイルへのアクセスが tier-guard で拒否される
- 既存の Personal/Confidential/Public モデルが壊れない

---

## Implementation Order

```
Phase 1 (Pipeline Composability)     ← 最もインパクト大。シナリオ再利用の基盤
  ↓
Phase 2 (Reactive Knowledge)         ← Phase 1 のサブパイプラインと連携
  ↓
Phase 3 (Design Protocol 汎化)       ← Phase 1-2 の基盤の上に構築
  ↓
Phase 4 (Dynamic Capability)         ← Phase 1 の routing に必要
  ↓
Phase 5 (Unified Observability)      ← Phase 1-4 の実行を可視化
  ↓
Phase 6 (Multi-tenant Tier)          ← 運用拡大時に対応
```

---

*Created: 2026-03-25 by KYBERION-PRIME*
*Status: Planning*
