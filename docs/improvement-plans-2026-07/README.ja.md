# コードベース改善計画 2026-07(索引)

> **作成日**: 2026-07-02
> **根拠**: リポジトリ全体調査(libs/core・libs/actuators・satellites/presence・scripts/pipelines・テスト/CI・docs の6領域を並列調査)
> **位置づけ**: [PRODUCTIZATION_ROADMAP](../../PRODUCTIZATION_ROADMAP.md) Phase B(30日連続運用に耐える)/ Phase C'(貢献容易性)に寄与する下位計画。
> **登録**: [docs/ROADMAP.md](../../ROADMAP.md) §1 に登録済み。

## 1. 目的

現時点のコードベースを俯瞰調査した結果から、品質・保守性・ガバナンス実効性を高める改善ポイントを14件に整理し、それぞれを **Claude Sonnet 4 クラスのモデルが単独で実装可能な粒度の実装計画** として文書化する。各計画はタスク単位で担当サブエージェントのモデルを指定する。

## 2. 実装担当モデルの割当方針

| モデル            | 用途                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `claude-sonnet-4` | **既定の実装担当**。コード変更・テスト追加・設定変更のすべての標準タスク       |
| `claude-haiku`    | 機械的な一括作業(パターンが確立した後の横展開、単純な削除・置換・フォーマット) |
| `claude-opus`     | 設計判断を伴うタスク(巨大ファイルの分割設計、特性化テストの設計、最終レビュー) |

各 IP 文書の「実装タスク」節に、タスクごとの担当モデルを明記している。**パターン確立(1件目)は sonnet、横展開(2件目以降)は haiku** が基本形。実装時のモデルIDは当時の最新安定版に読み替えてよい(例: sonnet 系の最新)。

### 2.1 実行時のモデル読み替え

この文書内の `claude-*` 表記は、実装手順上の**役割ラベル**として扱う。Codex 実行時は必要に応じて OpenAI 側のモデルへ読み替えてよい。

| 役割ラベル        | 実行時の推奨マッピング                 |
| ----------------- | -------------------------------------- |
| `claude-opus`     | `gpt-5.5` 系の設計・レビュー向けモデル |
| `claude-sonnet-4` | `gpt-5.4-mini` 系の標準実装向けモデル  |
| `claude-haiku`    | さらに軽量な mini 系モデル             |

厳密なモデル名よりも、各タスクの難度・検証量・横展開性に応じて適切な OpenAI モデルを選ぶことを優先する。

## 3. 改善ポイント一覧

| ID                                                   | タイトル                                                                   | 優先度 | 規模 | 依存      |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ---- | --------- |
| [IP-01](./IP-01_ESLINT_GOVERNANCE_ENFORCEMENT.ja.md) | ESLint ガバナンスの実効化(secure-io 不変条件の lint 復活)                  | **P0** | S    | なし      |
| [IP-02](./IP-02_NATIVE_ENGINE_SECURE_IO.ja.md)       | native-\*-engine 等の secure-io 不変条件違反の解消                         | **P0** | M    | IP-01     |
| [IP-03](./IP-03_CI_TEST_GATES.ja.md)                 | CI テスト実行範囲の拡大と品質ゲート強化                                    | **P0** | M    | なし      |
| [IP-04](./IP-04_DEAD_REFERENCE_CLEANUP.ja.md)        | 死んだ参照の一掃と参照整合性チェックの自動化                               | P1     | S    | なし      |
| [IP-05](./IP-05_ACTUATOR_CLI_RUNNER.ja.md)           | アクチュエータ CLI エントリポイントの共通化と入力検証                      | P1     | M    | なし      |
| [IP-06](./IP-06_WORKSPACE_CONSISTENCY.ja.md)         | ワークスペース整合性の回復(package.json 欠落・命名不統一)                  | P1     | S    | なし      |
| [IP-07](./IP-07_CRITICAL_PATH_TESTS.ja.md)           | クリティカルパスへのテスト追加(ADF修復・推論バックエンド等)                | **P0** | M    | なし      |
| [IP-08](./IP-08_ERROR_HANDLING_DISCIPLINE.ja.md)     | エラーハンドリング規律(握りつぶし catch・浮遊 Promise・process.exit)       | P1     | M    | IP-05推奨 |
| [IP-09](./IP-09_SHARED_UTILITY_CONSOLIDATION.ja.md)  | 重複ユーティリティの統合(slugify×14・retry×11 ほか)                        | P2     | S    | なし      |
| [IP-10](./IP-10_GOD_FILE_DECOMPOSITION.ja.md)        | 巨大ファイルの分割(4,500〜5,300行級 5ファイル)                             | P2     | L    | IP-07     |
| [IP-11](./IP-11_TYPE_SAFETY_RATCHET.ja.md)           | 型安全性ラチェット(strict 化・any 削減 約2,900箇所)                        | P2     | L    | IP-03     |
| [IP-12](./IP-12_EXECUTION_MODE_UNIFICATION.ja.md)    | スクリプト実行モードの統一と baseline-check 高速化                         | P2     | M    | なし      |
| [IP-13](./IP-13_MODEL_ID_CENTRALIZATION.ja.md)       | モデルIDの一元管理と陳腐化解消                                             | P1     | S    | なし      |
| [IP-14](./IP-14_REPO_HYGIENE.ja.md)                  | リポジトリ衛生(ハードコードパス・死んだ共有ライブラリ・陳腐化ドキュメント) | P2     | S    | なし      |

規模: S = 半日〜1日 / M = 2〜5日 / L = 1〜3週(フェーズ分割前提)

### UX 改善(ユーザー接点)

UI・CLI・会話ブリッジ・音声のユーザー接点調査(2026-07-02 追加)に基づく改善計画。既存の [PRODUCT_UX_EVALUATION_2026-05-29](../PRODUCT_UX_EVALUATION_2026-05-29.ja.md) の提言(UX-0 first-run 安定化 / UX-1 surface health / UX-2 ユースケース別オンボーディング)とは**重複しない**よう、同評価が扱っていない領域に限定している。

| ID                                                       | タイトル                                                               | 優先度 | 規模 | 依存  |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ------ | ---- | ----- |
| [UX-01](./UX-01_ERROR_PRESENTATION.ja.md)                | エラー提示の統一(生エラー露出と「無言の失敗」の解消)                   | **P0** | M    | なし  |
| [UX-02](./UX-02_PROGRESS_VISIBILITY.ja.md)               | 長時間処理の進捗可視化(パイプライン・ミッション・ブリッジ・チャット)   | P1     | M    | なし  |
| [UX-03](./UX-03_LANGUAGE_CONSISTENCY.ja.md)              | 言語一貫性(日本語既定オペレータへの英語ハードコード解消)               | P1     | M〜L | なし  |
| [UX-04](./UX-04_APPROVAL_CONFIRMATION_UNIFICATION.ja.md) | 承認・確認フローの統一(魔法の言葉廃止・破壊的操作の確認)               | P1     | M    | なし  |
| [UX-05](./UX-05_UX_CONTRACT_ENFORCEMENT.ja.md)           | UX 契約の code 化(語彙一元化・バリデータ実効化)                        | P2     | M    | UX-03 |
| [UX-06](./UX-06_ONBOARDING_DASHBOARD_INTEGRITY.ja.md)    | オンボーディング/ダッシュボード整合(半構成バグ・customer オーバーレイ) | P1     | S〜M | なし  |

### Actuator 能力(何ができるか)

アクチュエータの機能的能力(カタログ整合・需要ギャップ・外部連携深度)の調査(2026-07-02 追加)に基づく。コード品質(IP-05/06)とは別軸。

| ID                                               | タイトル                                                     | 優先度 | 規模 | 依存  |
| ------------------------------------------------ | ------------------------------------------------------------ | ------ | ---- | ----- |
| [AC-01](./AC-01_CAPABILITY_TRUTHFULNESS.ja.md)   | 能力の正直さ(プローブ全数化・カタログ/実装整合)              | **P0** | M    | なし  |
| [AC-02](./AC-02_UNHANDLED_INTENT_LOOP.ja.md)     | 未処理意図の解消と需要取り込みループ稼働                     | P1     | S〜M | なし  |
| [AC-03](./AC-03_DEPLOY_CICD_CAPABILITY.ja.md)    | デプロイ/CI-CD 実行能力の実体化                              | P1     | M    | AC-01 |
| [AC-04](./AC-04_CALENDAR_EMAIL_ROBUSTNESS.ja.md) | カレンダー/メール堅牢化とプラットフォーム依存緩和            | P1     | M    | AC-01 |
| [AC-05](./AC-05_JP_SAAS_AUTH_MATURITY.ja.md)     | 外部サービス認証の成熟化と日本 SaaS 接続(kintone パイロット) | P2     | M    | なし  |
| [AC-06](./AC-06_STUB_CAPABILITY_TRIAGE.ja.md)    | スタブ能力の整理と能力境界の明文化                           | P2     | S    | AC-01 |

### ナレッジ / メモリ管理

ナレッジシステム・メモリ管理の調査(2026-07-02 追加)に基づく。[VOLATILE_KNOWLEDGE_PLAN](../../VOLATILE_KNOWLEDGE_PLAN.ja.md) の再設計ではなく、その**起動・品質・統治の完成**が主眼。

| ID                                                | タイトル                                                      | 優先度 | 規模 | 依存  |
| ------------------------------------------------- | ------------------------------------------------------------- | ------ | ---- | ----- |
| [KM-01](./KM-01_VOLATILE_MEMORY_ACTIVATION.ja.md) | 揮発メモリ層の起動(cron 配線・GC 稼働・lifecycle 接続)        | **P0** | S    | なし  |
| [KM-02](./KM-02_RETRIEVAL_QUALITY.ja.md)          | 検索品質(本文チャンク索引・偽セマンティックの解消)            | P1     | M    | KM-04 |
| [KM-03](./KM-03_PROMOTION_GOVERNANCE_LOOP.ja.md)  | 記憶昇格ガバナンスの閉ループ(distill 正規化・dedup・矛盾防衛) | P1     | M    | KM-01 |
| [KM-04](./KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md)    | ナレッジストア衛生(テスト汚染1,387ファイル除去・索引自動生成) | P1     | S    | なし  |

### ミッション・オーケストレーション(SDLC/AI-DLC 型の遂行プロセス)

ミッションタイプ・実行プロセス・ゲーティング・タスク分配の調査(2026-07-02 追加)に基づく。**Claude Code / Fable 5 ハーネスのオーケストレーション原則**(計画承認ゲート、成果物を動かして検証、敵対的レビュー、アイテム独立パイプラインの並列分配、自己完結タスク契約とコンテキスト予算、タスク単位のモデル/エフォート選択、ジャーナルからの決定論的レジューム)を Kyberion のミッション制御モデルに翻訳したもの。各計画冒頭に対応原則を明記している。

| ID                                                | タイトル                                                                      | 優先度 | 規模 | 依存  |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ---- | ----- |
| [MO-01](./MO-01_MISSION_TYPE_EFFECTIVENESS.ja.md) | ミッションタイプの実効化(分類→プロセステンプレート駆動)                       | **P0** | M    | なし  |
| [MO-02](./MO-02_PHASE_GATES_VERIFICATION.ja.md)   | フェーズゲート実効化(計画ゲート・受入ゲート・敵対的レビュー・circuit breaker) | **P0** | M〜L | MO-01 |
| [MO-03](./MO-03_TASK_DAG_PARALLEL_DISPATCH.ja.md) | タスク契約と DAG 並列分配(直列 for ループ脱却・リース統合)                    | P1     | M〜L | MO-01 |
| [MO-04](./MO-04_WORKER_CONTEXT_ECONOMY.ja.md)     | ワーカーコンテキスト経済(context pack 配線・構造化結果契約)                   | P1     | S〜M | なし  |
| [MO-05](./MO-05_MODEL_EFFORT_ROUTING.ja.md)       | タスク単位モデル/エフォート・ルーティング(shadow→段階的 enforce)              | P1     | M    | MO-03 |
| [MO-06](./MO-06_DURABLE_RESUME.ja.md)             | 調整の永続化と決定論的レジューム(バス JSONL 化・イベント journal)             | P1     | S〜M | なし  |

### デザインシステム(Web / PPTX・文書 / 動画)

視覚成果物のデザイン定義の調査(2026-07-02 追加)に基づく。既存の [VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN](../VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN.ja.md)(VDS-01〜08 の配管はほぼ完了)と重複せず、未了の VDS-07 は DS-02 が引き取る。

| ID                                                  | タイトル                                                                   | 優先度 | 規模 | 依存  |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ---- | ----- |
| [DS-01](./DS-01_CANONICAL_DESIGN_TOKENS.ja.md)      | 正準デザイントークンと Web 4 面の統一(KDS 三重管理解消)                    | P1     | M    | なし  |
| [DS-02](./DS-02_TENANT_BRANDING_EVERYWHERE.ja.md)   | テナントブランディングの全面適用(PPTX 限定→Web/動画、VDS-07 実装)          | P1     | M    | DS-01 |
| [DS-03](./DS-03_DOCUMENT_THEME_JP_TYPOGRAPHY.ja.md) | 文書エンジンのテーマ駆動化と日本語タイポグラフィ(PDF フォント埋め込み)     | P1     | M    | DS-01 |
| [DS-04](./DS-04_VIDEO_SCENE_TOKENIZATION.ja.md)     | 動画シーンテンプレートのトークン化                                         | P2     | S〜M | DS-01 |
| [DS-05](./DS-05_A11Y_BASELINE.ja.md)                | アクセシビリティ基盤(reduced-motion・light/dark・コントラストゲート・ARIA) | P2     | M    | DS-01 |

### エージェント間通信(A2A / メッセージハブ / agent runtime)

エージェント間通信基盤の調査(2026-07-02 追加)に基づく。通信は2プレーン構成: ホスト内 A2A/ACP ランタイム面(a2aBridge → supervisor daemon → provider CLI)と、クロスホスト Mesh Hub 面(HTTP+HMAC・JSONL 配送台帳)。MO-03(並列分配)・MO-06(ミッション内バス永続化)とは重複しない。

| ID                                                   | タイトル                                                                   | 優先度 | 規模 | 依存  |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ---- | ----- |
| [AA-01](./AA-01_RUNTIME_RESILIENCE.ja.md)            | Agent runtime 耐障害化(クラッシュ検知・ask タイムアウト・デーモン堅牢化)   | **P0** | M    | なし  |
| [AA-02](./AA-02_MESH_HUB_DELIVERY_DRIVER.ja.md)      | Mesh Hub 配送ドライバ(実装済み at-least-once 状態機械の起動)               | **P0** | M    | なし  |
| [AA-03](./AA-03_A2A_IDENTITY_TRUST.ja.md)            | A2A アイデンティティと信頼の実効化(鍵永続化・署名 enforce・trust 尺度統一) | P1     | M    | なし  |
| [AA-04](./AA-04_CONVERSATION_BACKPRESSURE.ja.md)     | 会話モデルとバックプレッシャ(会話ストア・セッション復元・inflight 上限)    | P1     | M    | AA-01 |
| [AA-05](./AA-05_A2A_UNIFICATION_OBSERVABILITY.ja.md) | A2A 二重実装の整理とメッセージフロー統一観測                               | P2     | S〜M | AA-02 |

## 4. 優先度の根拠(要約)

- **P0 は「守っているつもりの防御が実際には効いていない」項目**。
  - IP-01: AGENTS.md §1 の secure-io 不変条件を強制するはずの ESLint ルールが、グローバル `ignores` により `scripts/**`・`tests/**`・`libs/core/*.ts` で無効化されている。
  - IP-02: その結果、`libs/core` 内部の native ドキュメントエンジン等 6 ファイルが raw `fs` で I/O しており、tier-guard/policy-engine を素通りしている。
  - IP-03: CI は smoke 1ファイル + `libs/core/` テストのみ実行。actuators 43・scripts 47・契約テスト約130ファイルは**どのワークフローでも実行されない**。カバレッジ閾値(60%)も未強制。
  - IP-07: AGENTS.md §1 が必須と定める `validateAndRepairAdf`(ADF 修復)にテストが**ゼロ**。実トークンを消費する推論アダプタ群も未テスト。
- **P1 は放置すると事故・手戻りに直結する構造問題**(壊れた npm script、27重コピペ、workspace 外パッケージ、握りつぶされた例外、陳腐化したモデルID)。
- **P2 は中期の保守性投資**(巨大ファイル、型安全、重複ユーティリティ、衛生)。

## 5. 推奨実施順序

```
Wave 1 (即時・並行可): IP-01 → IP-02, IP-03, IP-04, IP-13, UX-01, UX-06, KM-01, KM-04, AC-01, MO-01, AA-01
Wave 2:                IP-07, IP-05, IP-06, UX-02, UX-04, AC-02, KM-03, MO-02, MO-04, DS-01, AA-02, AA-03
Wave 3:                IP-08, IP-09, IP-12, IP-14, UX-03, AC-03, AC-04, KM-02, MO-03, MO-06, DS-02, DS-03, AA-04
Wave 4 (継続的):       IP-10, IP-11, UX-05, AC-05, AC-06, MO-05, DS-04, DS-05, AA-05
```

各 IP は独立したブランチ/パッチ単位で完結させる。1つの IP 内でもタスク単位でコミットを分け、`pnpm lint && pnpm typecheck && pnpm test:unit` を各コミットで通すこと。

## 6. 共通の作業規約(全 IP 共通・実装エージェントへの指示)

1. **ファイル I/O は必ず `@agent/core/secure-io` 経由**(AGENTS.md §1)。この計画の実装作業自体も不変条件に従うこと。
2. 変更前に対象ファイルを必ず読み、この計画に記載の行番号が現状とずれていれば現状を正とする(行番号は 2026-07-02 時点)。
3. テストを先に緑で確認 → 変更 → 同テストが緑のままであることを確認、の順で進める。
4. 挙動を変える判断(fail-open → fail-closed 等)は計画に明記がない限り行わず、TODO コメントと本計画への参照を残して報告する。
5. 一時ファイルは `active/shared/tmp/` のみ使用。
