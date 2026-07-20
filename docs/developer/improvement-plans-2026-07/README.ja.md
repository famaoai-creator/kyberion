# コードベース改善計画 2026-07(索引)

> **作成日**: 2026-07-02
> **根拠**: リポジトリ全体調査(libs/core・libs/actuators・satellites/presence・scripts/pipelines・テスト/CI・docs の6領域を並列調査)
> **位置づけ**: [PRODUCTIZATION_ROADMAP](../../PRODUCTIZATION_ROADMAP.md) Phase B(30日連続運用に耐える)/ Phase C'(貢献容易性)に寄与する下位計画。
> **登録**: [docs/ROADMAP.md](../../ROADMAP.md) §1 に登録済み。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)(2026-07-05 全計画をコード実態と突合して監査)。各計画文書内の記述と矛盾する場合は STATUS を正とする。
> **最新の横断レビュー**: [REVIEW_CODEX_2026-07-11.ja.md](./REVIEW_CODEX_2026-07-11.ja.md)(UX・拡張性・セキュリティ・運用の再監査と優先バックログ)。
> **UI/UX 持続運営レビュー**: [UI_UX_DESIGN_SYSTEM_SUSTAINABILITY_PLAN_2026-07-13.ja.md](./UI_UX_DESIGN_SYSTEM_SUSTAINABILITY_PLAN_2026-07-13.ja.md)(DS-01/UX-05 の完了と週次 drift audit)。
> **ループ完結計画**: [LOOP_CLOSURE_PLAN_2026-07-13.ja.md](./LOOP_CLOSURE_PLAN_2026-07-13.ja.md)(LC-01〜12: 実行成功→pipeline 昇格・LLM 判断配置・stub 縮退遮断・却下理由→修正再実行の4ループ)。
> **実行レイヤリング計画**: [LAYERED_EXECUTION_PLAN_2026-07-15.ja.md](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)(LE-01〜05: pipeline=配線 / typed ops=ロジック / デザインシステム=単一カスケードの3層分離。PPTX デザイン乖離の根治と script ラッパー pipeline の解消)。

## 1. 目的

現時点のコードベースを俯瞰調査した結果から、品質・保守性・ガバナンス実効性を高める改善ポイントを、後続追加を含め現時点で 98 件に整理し、それぞれを **Claude Sonnet 4 クラスのモデルが単独で実装可能な粒度の実装計画** として文書化する。各計画はタスク単位で担当サブエージェントのモデルを指定する。

## 2. 実装担当モデルの割当方針

| モデル            | 用途                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `claude-sonnet-4` | **既定の実装担当**。コード変更・テスト追加・設定変更のすべての標準タスク       |
| `claude-haiku`    | 機械的な一括作業(パターンが確立した後の横展開、単純な削除・置換・フォーマット) |
| `claude-opus`     | 設計判断を伴うタスク(巨大ファイルの分割設計、特性化テストの設計、最終レビュー) |

各 IP 文書の「実装タスク」節に、タスクごとの担当モデルを明記している。**パターン確立(1件目)は sonnet、横展開(2件目以降)は haiku** が基本形。実装時のモデルIDは当時の最新安定版に読み替えてよい(例: sonnet 系の最新)。

### 2.1 実行時のモデル読み替え

この文書内の `claude-*` 表記は、実装手順上の**役割ラベル**として扱う。実行時は Codex 側で利用可能な OpenAI モデルへ必要に応じてマッピングしてよい。

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

### QA(ソフトウェア品質ライフサイクル)

DoR・AC・DoDを正準契約として定義し、要求/リスク/変更影響からの試験観点抽出、項目設計、安全な試験実行、欠陥・再試験、品質報告、人間によるリリース責任までを一つの証跡チェーンにする。IP-03/07 の「Kyberion 自身のテスト基盤」とは別に、Kyberion が任意のソフトウェア開発を QA 業務として遂行する能力を扱う。

| ID                                                | タイトル                                                                 | 優先度 | 規模 | 依存        |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------ | ---- | ----------- |
| [QA-01](./QA-01_SOFTWARE_QUALITY_LIFECYCLE.ja.md) | DoR・AC・DoDから観点抽出・試験実行・欠陥管理・品質報告までの標準QAフロー | **P0** | L    | MO-02,IL-01 |

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

| ID                                                   | タイトル                                                                               | 優先度 | 規模 | 依存              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ | ---- | ----------------- |
| [MO-01](./MO-01_MISSION_TYPE_EFFECTIVENESS.ja.md)    | ミッションタイプの実効化(分類→プロセステンプレート駆動)                                | **P0** | M    | なし              |
| [MO-02](./MO-02_PHASE_GATES_VERIFICATION.ja.md)      | フェーズゲート実効化(計画ゲート・受入ゲート・敵対的レビュー・circuit breaker)          | **P0** | M〜L | MO-01             |
| [MO-03](./MO-03_TASK_DAG_PARALLEL_DISPATCH.ja.md)    | タスク契約と DAG 並列分配(直列 for ループ脱却・リース統合)                             | P1     | M〜L | MO-01             |
| [MO-04](./MO-04_WORKER_CONTEXT_ECONOMY.ja.md)        | ワーカーコンテキスト経済(context pack 配線・構造化結果契約)                            | P1     | S〜M | なし              |
| [MO-05](./MO-05_MODEL_EFFORT_ROUTING.ja.md)          | タスク単位モデル/エフォート・ルーティング(shadow→段階的 enforce)                       | P1     | M    | MO-03             |
| [MO-06](./MO-06_DURABLE_RESUME.ja.md)                | 調整の永続化と決定論的レジューム(バス JSONL 化・イベント journal)                      | P1     | S〜M | なし              |
| [MO-07](./MO-07_QUALITY_MAXIMIZING_DELEGATION.ja.md) | 品質最大化タスク移譲(休眠品質機構の起動・best-of-N・judge・敵対レビュー・draft-refine) | P1     | L    | MO-02,MO-04,MO-05 |
| [MO-08](./MO-08_ARTIFACT_REVIEW_CLOSURE.ja.md)       | 成果物品質レビューと Mission 終了処理の分離(hash-bound review・reconcile・finish)      | **P0** | M    | MO-02,MO-05       |

### デザインシステム(Web / PPTX・文書 / 動画)

視覚成果物のデザイン定義の調査(2026-07-02 追加)に基づく。既存の [VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN](../VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN.ja.md)(VDS-01〜08 の配管はほぼ完了)と重複せず、未了の VDS-07 は DS-02 が引き取る。

| ID                                                  | タイトル                                                                   | 優先度 | 規模 | 依存  |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ---- | ----- |
| [DS-01](./DS-01_CANONICAL_DESIGN_TOKENS.ja.md)      | 正準デザイントークンと Web 4 面の統一(KDS 三重管理解消) **(完了)**         | P1     | M    | なし  |
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

### セキュリティ・監査・統制

セキュリティ多層防御と監査/統制の完全性の調査(2026-07-02 追加)に基づく。IP-01/02/08・AC-05・AA-03 が扱わない残余領域。**構想評価レポートで「宣言と執行の乖離」として指摘した中核**(統制が効いていない)への実装。

| ID                                             | タイトル                                                            | 優先度 | 規模 | 依存        |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------ | ---- | ----------- |
| [SA-01](./SA-01_AUDIT_CHAIN_INTEGRITY.ja.md)   | 監査チェーンの真正性(鍵付き・継続保証・定期検証)                    | **P0** | M    | なし        |
| [SA-02](./SA-02_ADF_SHELL_GUARDRAILS.ja.md)    | ADF/シェル実行ガードレール(危険op走査・無条件Bash廃止・fail-closed) | **P0** | M〜L | なし        |
| [SA-03](./SA-03_UNTRUSTED_INPUT_DEFENSE.ja.md) | 非信頼入力・プロンプトインジェクション防御                          | P1     | M    | SA-02       |
| [SA-04](./SA-04_EGRESS_CONTROL.ja.md)          | データ持ち出し(egress)制御(allowlist全適用・tier照合)               | P1     | M    | なし        |
| [SA-05](./SA-05_ENFORCEMENT_ACTIVATION.ja.md)  | 統制機構の実効化(kill-switch 配線・ポリシー/承認の fail-closed 化)  | **P0** | M    | SA-02,SA-04 |

### 運用・可観測性・配布

コスト会計・可観測性・配布/インストール・バックアップ/復旧・設定の調査(2026-07-02 追加)に基づく。統一 Trace(D3)・IP-03・AA-05・IP-12・KM-01 が扱わない残余領域。

| ID                                                   | タイトル                                                        | 優先度 | 規模 | 依存  |
| ---------------------------------------------------- | --------------------------------------------------------------- | ------ | ---- | ----- |
| [OP-01](./OP-01_COST_ACCOUNTING.ja.md)               | LLM コスト会計と予算上限(直接SDK経路の計測・spend cap)          | **P0** | M    | IP-13 |
| [OP-02](./OP-02_BACKUP_RECOVERY.ja.md)               | バックアップと災害復旧(全状態のスナップショット・復元ツール)    | **P0** | M    | なし  |
| [OP-03](./OP-03_INSTALL_DISTRIBUTION.ja.md)          | インストールと配布(死んだ init 修復・bin・動く Docker イメージ) | P1     | M    | IP-04 |
| [OP-04](./OP-04_HEALTH_DEGRADATION_MONITORING.ja.md) | 長期運用の健全性・劣化監視(予兆検知・health エンドポイント)     | P1     | M    | AA-01 |
| [OP-05](./OP-05_CONFIG_SURFACE.ja.md)                | 設定サーフェスの一元化(181 env のレジストリ・起動時検証)        | P2     | S〜M | なし  |

### インテントライフサイクル(受信→ゴール→完了の縦串)

ユーザーインテントから完了までの縦のフローの縫い目の調査(2026-07-02 追加)に基づく。MO 系(ミッション内部機構)・UX 系(明確化/進捗の体裁)・AC-02(未処理意図)とは層が別で、「元の intent の goal を縦に貫き完了時に突き合わせる」接続に焦点。

| ID                                                          | タイトル                                                               | 優先度 | 規模 | 依存        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------ | ---- | ----------- |
| [IL-01](./IL-01_GOAL_THREADING.ja.md)                       | ゴールの貫通(受信時 goal を実行まで運ぶ・汎用 outcome contract 廃止)   | **P0** | M    | なし        |
| [IL-02](./IL-02_CORRELATION_THREAD.ja.md)                   | intent→goal→result 相関スレッド(単一相関IDの貫通・trace 閲覧)          | P1     | M    | IL-01       |
| [IL-03](./IL-03_DRIFT_DETECTION.ja.md)                      | ドリフト検出の是正(起点比較・全経路 baseline・実行中ゲート)            | P1     | M    | IL-01,IL-02 |
| [IL-04](./IL-04_COMPLETION_INTENT_RECONCILIATION.ja.md)     | 完了とインテントの突合(close-the-loop・完了ゲート・全shape)            | **P0** | M    | IL-01       |
| [IL-05](./IL-05_SHAPE_UNIFICATION_CORRECTION_REENTRY.ja.md) | shape 決定の一元化と修正の再突入(pending 永続化・completed 再オープン) | P2     | M    | IL-01,IL-02 |

### 初回オンボーディング(すんなり使い始められるか)

初回オンボード体験の実地調査(2026-07-02)に基づく。UX-06(オンボードバグ)・OP-03(配布)・UX-03(言語)が扱わない新規ギャップ。**最重大の発見: 新規ユーザーは推論バックエンド未設定でもオンボードが「成功」し、スタブ脳のまま実作業へ誘導される。**

| ID                                                    | タイトル                                                                     | 優先度 | 規模 | 依存                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ---- | --------------------------------- |
| [ONB-01](./ONB-01_REASONING_BACKEND_ONBOARDING.ja.md) | 実働バックエンドのオンボード統合(スタブ脳で成功する問題の解消)               | **P0** | M    | なし                              |
| [ONB-02](./ONB-02_CANONICAL_COLDSTART.ja.md)          | コールドスタートの単一正本化(5矛盾手順・Node統一・Playwright・統合preflight) | **P0** | M    | なし                              |
| [ONB-03](./ONB-03_ONBOARDING_FRICTION_RECOVERY.ja.md) | オンボード摩擦削減(express・reset・resume修復・Path B・vital overlay)        | P1     | S〜M | UX-06                             |
| [ONB-04](./ONB-04_AI_COMPANY_STARTUP_UX.ja.md)        | AI会社起業オンボーディング(human責任者・AI workforce・承認/予算・first-work) | **P0** | M    | ONB-01,ONB-02,ONB-03,CO-06,E2E-04 |

### Surface UI capability(何が操作できると嬉しいか)

surface が提供する UI の機能的アフォーダンスの調査(2026-07-03)に基づく。視覚デザイン(DS 系)・体験の体裁(UX 系)とは別軸で、「毎日開く価値のある操作」を実装する。A2UI 仕様の `kb-intervention-panel` 等は描画されるが未配線(inert)。

| ID                                                    | タイトル                                                                  | 優先度 | 規模 | 依存              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------ | ---- | ----------------- |
| [SU-01](./SU-01_OPERATOR_HOME_INTENT_TO_PLAN.ja.md)   | オペレータホームとゴール表明→プラン承認(二値確認の廃止・プラン編集)       | P1     | L    | IL-01,IL-04,MO-01 |
| [SU-02](./SU-02_LIVE_MISSION_INTERVENTION.ja.md)      | ライブミッション監視と実行中介入(pause/cancel/回答・kb-panel 配線)        | P1     | M    | MO-02,AA-04       |
| [SU-03](./SU-03_DELIVERABLE_INBOX_REVIEW.ja.md)       | 成果物インボックスとレビュー・反復(accept/reject/request-changes・版管理) | P1     | M    | IL-04,MO-07       |
| [SU-04](./SU-04_MISSION_HISTORY_COST_APPROVALS.ja.md) | ミッション履歴検索・コスト可視化・承認キュー・テナントバナー              | P2     | M    | OP-01,IL-02       |

### E2E(オペレータ接点の最小統合)

`E2E-04` は SU-01 / SU-03 の最小形を引き取る統合計画。入口(話しかける場所)は分散のまま、ホームと受け取り口を1つにまとめる。

| ID                                          | タイトル                                                        | 優先度 | 規模 | 依存        |
| ------------------------------------------- | --------------------------------------------------------------- | ------ | ---- | ----------- |
| [E2E-04](./E2E-04_OPERATOR_INTERFACE.ja.md) | オペレータ・インターフェース統合(ホーム/inbox/計画承認の最小形) | **P0** | M〜L | UX-01,IL-01 |

### Handoff(SDLC/AI-DLC の引き継ぎ)

作業が別 holder に渡る瞬間の文脈保持の調査(2026-07-03)に基づく。MO-04(コンテキスト)・IL-01(goal 貫通)を補完。AI-DLC は完全人手コピペで未実装、Cowork 連携が最も成熟した自己完結パケットを持つ。

| ID                                                       | タイトル                                                                                            | 優先度 | 規模 | 依存              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ | ---- | ----------------- |
| [HO-01](./HO-01_HANDOFF_PACKETS.ja.md)                   | 自己完結ハンドオフパケット(work-item/mission handoff・契約に rationale/受入条件・承認 framing 配線) | P1     | M    | MO-04,IL-01       |
| [HO-02](./HO-02_AIDLC_PHASE_HANDOFF_OBSERVABILITY.ja.md) | AI-DLC フェーズハンドオフの自動化と統合ハンドオフ履歴                                               | P2     | M〜L | MO-01,MO-02,HO-01 |

### ハーネス(Fable 5 のオーケストレーション取り込み)

「軽量モデルでも高品質な成果を出すオーケストレーションの型」を Kyberion に取り込む。思想は参照文書 [ORCHESTRATION_HARNESS_MODEL](../ORCHESTRATION_HARNESS_MODEL.ja.md)(タスク分解・ブリフ・順序・成果物評価・改善ループ・通信・エージェントループの原則体系 + Kyberion 現状マッピング)にまとめ、既存の原則ギャップを以下に計画化。

| ID                                                 | タイトル                                                                                | 優先度 | 規模 | 依存        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ | ---- | ----------- |
| [HN-01](./HN-01_MODEL_TIER_LIGHTWEIGHT.ja.md)      | モデル階層の実効化と軽量モデル活用の規律(tier/effort・軽量ほど厳格)                     | P1     | M    | MO-05,IP-13 |
| [HN-02](./HN-02_SCHEMA_FORCED_DELEGATION.ja.md)    | schema-forced 委譲(検証済みオブジェクト返却・retry-on-mismatch・出力契約検証)           | P1     | M    | なし        |
| [HN-03](./HN-03_DETERMINISTIC_ORCHESTRATION.ja.md) | 決定論オーケストレーション強化(並列map・loop-until・workflow-as-code・無音打ち切り解消) | P1     | L    | MO-03       |

### OpenHarness 概念取り込み(コンテキスト経済・ガバナンス硬化・実行前判定)

[HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) の実コード分析(2026-07-18)に基づく。正本は [OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md](./OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md)(OH-01〜08 は同文書内)。コードは取り込まず概念のみ既存契約へ昇華する(browser-cli 方式)。MO-04・SA-03・AC-01 の実装参照を与える。

| ID    | タイトル                                                                   | 優先度 | 規模 | 依存         |
| ----- | -------------------------------------------------------------------------- | ------ | ---- | ------------ |
| OH-01 | ワーカーコンテキスト自動圧縮 + carryover(2段階圧縮・task-focus 構造化継承) | **P0** | M    | OH-04推奨    |
| OH-02 | 資格情報パスの常時 deny 層(上書き不可・3経路適用)                          | **P0** | S    | なし         |
| OH-03 | transient エラーの in-place backoff(Retry-After 尊重・demotion 前段)       | P1     | S    | なし         |
| OH-04 | ツール出力のアーティファクト退避(inline preview + mission-local 保存)      | P1     | S    | なし         |
| OH-05 | MCP クライアント成熟化(HTTP transport・schema inference・失敗隔離)         | P1     | M    | AC-01参照    |
| OH-06 | リクエスト級 dry-run 判定(ready/warning/blocked + next_actions)            | P2     | S    | なし         |
| OH-07 | チーム承認伝播(mission-scoped grant・TTL 付き)                             | P2     | M    | SA-01参照    |
| OH-08 | チャネル拡張 Feishu/DingTalk(需要確定まで backlog)                         | P2     | L    | 需要トリガー |

### Hermes Agent 概念取り込み(自律学習ループ・履歴全文検索・実行環境抽象)

[NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) の実コード分析(2026-07-18)に基づく。正本は [HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md](./HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md)(HA-01〜09 は同文書内)。同じく概念昇華方式。OH-01 への圧縮実装の補強詳細(aux model・token 予算尾部・filter-safe preamble 等)は同文書 §2.1、チャネル層(iMessage/承認/配信堅牢化)の診断は同文書 §1.4 に記載。

| ID    | タイトル                                                                          | 優先度 | 規模 | 依存            |
| ----- | --------------------------------------------------------------------------------- | ------ | ---- | --------------- |
| HA-01 | 自律学習ループ(background review fork・記録禁止ポリシー・curator)                 | P1     | M    | KM-03,LC-02参照 |
| HA-02 | 会話・ミッション履歴の FTS 検索(trigram CJK・ゼロ LLM 想起・tier フィルタ)        | P1     | M    | なし            |
| HA-03 | Automation Blueprint(スロットスキーマ単一定義・deliver_to 一級化)                 | P2     | S〜M | AA-02参照       |
| HA-04 | op 合成スクリプト実行 PTC(stdout のみ復帰・許可 op 交差・LE 整合)                 | P2     | M    | AR-02,AR-03推奨 |
| HA-05 | 実行環境抽象 EnvironmentBackend(local/Docker/SSH・需要確定まで backlog)           | P2     | L    | 需要トリガー    |
| HA-06 | チャネル承認 UI の contract 化(Slack 専用解消・テキスト fallback)                 | P1     | M    | なし            |
| HA-07 | imessage-bridge 硬化(グループ返信バグ修正・mention gating・outbox 配線)           | P1     | M    | HA-06,HA-08連携 |
| HA-08 | surface 配信の堅牢化(error 分類・dead-letter — mesh broker 状態機械の流用)        | P1     | S〜M | AA-02参照       |
| HA-09 | surface capability 宣言と chunking 中央化(上限分割・markdown fallback・allowlist) | P2     | M    | なし            |

### Kimi CLI 概念取り込み(実行時セルフガバナンス・観測契約・委譲ハードニング)

[MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) の実コード分析(2026-07-20)に基づく。正本は [KIMI_CLI_ADOPTION_PLAN_2026-07-20.ja.md](./KIMI_CLI_ADOPTION_PLAN_2026-07-20.ja.md)(KC-01〜10 は同文書内)。同じく概念昇華方式。実行**中**のワーカーループを守る機構(反復検知・巻き戻し)、型付きイベントストリーム(記録/再生/e2e)、承認・フック・委譲の運用小物に実装参照を与える。

| ID    | タイトル                                                             | 優先度 | 規模 | 依存         |
| ----- | -------------------------------------------------------------------- | ------ | ---- | ------------ |
| KC-01 | ツール呼び出し反復ガバナー(streak 検知・段階的警告・強制停止)        | **P0** | S    | なし         |
| KC-02 | ワーカーイベントストリーム契約(型付き envelope・記録/再生・e2e)      | P1     | M    | なし         |
| KC-03 | 承認ランタイム強化(セッション action キャッシュ・source 単位 cancel) | P1     | S    | KC-02推奨    |
| KC-04 | ライフサイクルフックエンジン一般化(13 イベント・fail-open)           | P1     | M    | KC-02推奨    |
| KC-05 | AI 監査テスト層(markdown 不変条件 → subagent fan-out 監査)           | P1     | S    | なし         |
| KC-06 | 委譲ハードニング(要約 retry・再開可能 store・完了通知の文脈注入)     | P1     | S    | OH-01連携    |
| KC-07 | チェックポイント付き文脈巻き戻し D-Mail(実験)                        | P2     | M    | KC-02,OH-01  |
| KC-08 | 動的注入 provider 契約(throttle・圧縮後リセット)                     | P2     | S    | KC-01,06連携 |
| KC-09 | completion token 動的予算(OH-01 追補)                                | P3     | S    | なし         |
| KC-10 | Mermaid フロー → pipeline compiler(需要確定まで backlog)             | P3     | S    | 需要トリガー |

### メディア生成プロセス(HyperFrames / Anthropic skills の作成プロセス移植)

[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) の skills 群・design ガイドと [anthropics/skills](https://github.com/anthropics/skills)(pptx/frontend-design/canvas-design 等)の実プロセス分析(2026-07-20)に基づく。正本は [MEDIA_CREATION_PROCESS_PLAN_2026-07-20.ja.md](./MEDIA_CREATION_PROCESS_PLAN_2026-07-20.ja.md)(MP-01〜06 は同文書内)。動画・PPTX のデザイン品質を「ブリーフロック→トークン先行→ビート/ページ設計→lint→レンダリング視覚批評→限定修正」の段階ゲート型プロセスへ転換する。LE(スタイルカスケード統一)の後続として、レイアウト知能(テキスト計測)と視覚検証ループを補う。

| ID    | タイトル                                                                     | 優先度 | 規模 | 依存        |
| ----- | ---------------------------------------------------------------------------- | ------ | ---- | ----------- |
| MP-01 | デザイン語彙拡充(タイポスケール/スペーシング/制約トークン・engine 直接消費)  | **P0** | M    | DS-01,LE-02 |
| MP-02 | 動画オーサリング転換(モーション語彙統制・読了時間ビート尺・lint・降格表面化) | P1     | L    | MP-01,MP-04 |
| MP-03 | PPTX レイアウトフィット(テキスト計測・自動リフロー・機械分割全廃)            | **P0** | M    | MP-01       |
| MP-04 | 視覚QAループ(render→snapshot→批評→修正、動画/PPTX 共通)                      | P1     | M    | MP-01       |
| MP-05 | インテントフロー見直し(ブリーフロック・run-shape・house-style 蒸留)          | P1     | M    | MP-01〜04   |
| MP-06 | 受け入れ検証(ゴールデンブリーフ・文字ズレ回帰・決定論テスト)                 | P1     | S    | MP-01〜05   |
| MP-07 | body-zone 語彙拡充(region 宣言駆動・新ゾーン6種・semantic マッピング拡張)    | P1     | M    | MP-03,MP-06 |

### Actuator リファクタリング/使いやすさ(ADFスキーマ・op)

各アクチュエータのリファクタリング・使いやすさの調査(2026-07-03、実コード検証済み)に基づく。AC 系(能力)・IP-05(CLI runner)・IP-10(巨大ファイル)とは**別軸**(op 設計・ADFスキーマ・エンジン一貫性)。**検証で判明した構造的問題: 3つの非互換パイプラインエンジン、op 真実源の4系統ドリフト、未知 op の silent no-op(`file-pipeline-helpers.ts:178/237/249`)、op 命名の乱れ、per-op 入力契約の欠如。**

| ID                                                  | タイトル                                                                          | 優先度 | 規模 | 依存              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ------ | ---- | ----------------- |
| [AR-01](./AR-01_UNIFY_ADF_ENGINE.ja.md)             | ADF 実行エンジンの統合(3非互換エンジン→1、意味論一致)                             | **P0** | L    | なし              |
| [AR-02](./AR-02_OP_REGISTRY_SINGLE_SOURCE.ja.md)    | op レジストリの単一真実源化(dispatch から生成・4系統ドリフト解消)                 | **P0** | M    | なし              |
| [AR-03](./AR-03_PER_OP_INPUT_CONTRACTS.ja.md)       | per-op 入力契約(`params:any` → 検証付き契約・必須/例)                             | P1     | M〜L | AR-02             |
| [AR-04](./AR-04_SHARED_OP_VOCABULARY.ja.md)         | 共有 op 語彙(io/capture/net/transform/core・命名エイリアス整理)                   | P1     | M    | AR-01,AR-02       |
| [AR-05](./AR-05_ACTUATOR_COHERENCE_SPLIT.ja.md)     | 不整合アクチュエータの分割(観察/変更・ドメイン境界、IP-10 と統合)                 | P2     | L    | AR-01,AR-02       |
| [AR-06](./AR-06_NO_SILENT_NOOP.ja.md)               | silent no-op の撲滅(未知 op を成功でなくエラーに)                                 | P1     | S    | AR-02推奨         |
| [AR-08](./AR-08_PIPELINE_CATALOG_AUDIT.ja.md)       | pipeline カタログ全数監査(77件・実行検証55件・ADF修復エンジンのfalse-success修正) | P1     | M    | AR-01,AR-02       |
| [AR-09](./AR-09_ACTUATOR_COMMONIZATION.ja.md)       | actuator 共通能力の正本化(recovery/process/voice/job/HTTP)                        | P1     | L    | AR-02,AR-03       |
| [AR-10](./AR-10_MACOS_AUTOMATION_INTEGRATION.ja.md) | macOS automation capability の共通 facade と system probe                         | P1     | M    | AR-02,AR-03,AR-09 |

### 実行レイヤリング(pipeline / typed ops / デザインシステムの3層分離)

PPTX デザイン乖離の調査(2026-07-15)に基づく。正本は [LAYERED_EXECUTION_PLAN_2026-07-15.ja.md](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)(LE-01〜05 は同文書内)。AR-02/AR-08/DS-01/HN-03/E2E-02 の完了済み成果を接続する。

| ID    | タイトル                                                             | 優先度 | 規模 | 依存         |
| ----- | -------------------------------------------------------------------- | ------ | ---- | ------------ |
| LE-01 | PPTX デザインデフォルトカスケード(engine 側補完・opt-in)             | **P0** | S〜M | なし         |
| LE-02 | レイアウトプリミティブの engine 側移植(3経路の定数一元化)            | P1     | M    | LE-01        |
| LE-03 | script ラッパー pipeline の typed op 化(reconcile 3本から)           | P1     | M〜L | AR-02, AR-03 |
| LE-04 | 使い分け基準の正本化(AGENTS.md・README・core:transform 警告 lint)    | P1     | S    | なし         |
| LE-05 | pipeline コーパス常設静的テスト(全数 schema+guardrails・schema 締め) | P1     | S〜M | AR-08        |

### 自律運用・保守(長時間の無人運用に任せる)

30日連続の無人運用・自己保守に必要な機構の調査(2026-07-03)に基づく。判断の考え方は参照文書 [AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md)(自動/承認の4軸・脆弱性パッチのルーブリック・運用ループ・エスカレーション基準)にまとめ、それを回す機構を以下に計画化。既存の OP/AA/SA/KM 系を束ねる。**調査結論: 現状では30日無人運用は任せられない**(スケジューラにジョブゼロ・デーモン無監督・依存/CVEパッチ機構皆無・アラート経路不在)。

| ID                                                   | タイトル                                                                                          | 優先度 | 規模 | 依存              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ | ---- | ----------------- |
| [AO-01](./AO-01_AUTONOMOUS_MAINTENANCE_LOOP.ja.md)   | 自律保守ループと定期メンテの実配線(scheduler実ジョブ・missed-run/lock・判断駆動の振り分け)        | P1     | M    | KM-01,OP-04,AO-03 |
| [AO-02](./AO-02_DEPENDENCY_VULN_PATCH.ja.md)         | 依存・脆弱性・パッチ管理(CVE追跡・ルーブリック駆動のパッチ適用フロー)                             | **P0** | M    | IP-03,AO-01,AO-03 |
| [AO-03](./AO-03_DAEMON_SUPERVISION_ESCALATION.ja.md) | デーモン監督と人間エスカレーション(watchdog・launchd完備・実アラートsink・自己修復の承認ゲート化) | **P0** | M    | なし              |
| [AO-04](./AO-04_SOAK_ENDURANCE_VALIDATION.ja.md)     | 長時間運用の耐久検証(soak・リーク検出・再起動e2e・30日エビデンス)                                 | P1     | M    | AO-01,AO-02,AO-03 |

### E2E 縦一気通貫(中核ユースケースの実流)

「部品はあるのに流れない」を、継ぎ目の配線と前提の事前検出で解消する実流計画(2026-07-05 追加)。

| ID                                           | タイトル                                                                                                      | 優先度 | 規模 | 依存                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ | ---- | --------------------------------------------------------- |
| [E2E-01](./E2E-01_MEETING_TO_VALUE.ja.md)    | 会議→価値提供の縦一気通貫(声学習→本人ボイス会議→議事録→アクションアイテム→タスク→顧客提供。Task 1-7 実装済み) | **P0** | M    | なし(AC-01/UX-01/OP-02 の成果を利用)                      |
| [E2E-02](./E2E-02_CREATIVE_SUITE.ja.md)      | クリエイティブ統合(動画・パワポ・音楽・MV・Web を1つのデザインシステムで)                                     | **P0** | M〜L | DS-01。DS-02/DS-04 未了分を引き取る                       |
| [E2E-03](./E2E-03_AGENT_COLLABORATION.ja.md) | エージェント協調(上流成果の可視化・review往復・best-of-N・PR協調)                                             | **P0** | M〜L | MO-03/MO-04/HO-01/IL-01 を利用。MO-02 と棲み分け          |
| [E2E-04](./E2E-04_OPERATOR_INTERFACE.ja.md)  | オペレータ・インターフェース統合(入口・ホーム・通知・inbox・plan-preview・CLI 経路統一)                       | **P0** | M〜L | UX-01/IL-01/E2E-01〜03 の成果を利用。SU-01/SU-03 の最小形 |
| [E2E-05](./E2E-05_APP_LIFECYCLE.ja.md)       | アプリ開発ライフサイクル(iOS/Android の AI-DLC/SDLC 全工程自動化: build/scaffold/デバイステスト/配布)         | **P0** | L    | E2E-03/MO-02 と接続。AC-01/AC-03/IP-05 を利用             |
| [E2E-06](./E2E-06_CUSTOMER_DIALOGUE.ja.md)   | 顧客対話ドリブン(顧客チャネル・接地ガードレール・deal 状態機械・見積/契約・要件吸収→SDLC)                     | **P0** | L    | E2E-01/04/05 と接続。SA-03/SA-04 の防御思想に従う         |

### Company OS(会社を経営する OS 層)

「1人 + AI で AIスタートアップを回す」ための会社経営レイヤーの調査(2026-07-03)に基づく。コンセプトは参照文書 [COMPANY_OS_CONCEPT](../COMPANY_OS_CONCEPT.ja.md)(可能かの診断・組織/業務の表現方法)。既存プリミティブ(vision/role/agent/tenant/mission/pipeline)で業務は表現・実行できるが、会社を束ねる集約層・財務/KPI/意思決定のデータ化が未完。それを埋める。

| ID                                              | タイトル                                                                               | 優先度 | 規模 | 依存                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | ------ | ---- | --------------------------------------- |
| [CO-01](./CO-01_COMPANY_ENTITY.ja.md)           | 会社の集約エンティティと理念の runtime 配線(散在5ファイルの統合・per-tenant vision)    | P1     | M    | なし                                    |
| [CO-02](./CO-02_ORG_CHART_ROLES.ja.md)          | 組織図のデータ化とカスタムロール作成フロー(CFO/営業を作れる・固定でなく mission 派生)  | P2     | M    | CO-01,SA-05                             |
| [CO-03](./CO-03_FINANCIAL_KPI_MODEL.ja.md)      | 財務・KPI・OKR モデリング(P&L/予算/予測・OKR・経営判断への接続)                        | P1     | M〜L | CO-01,OP-01                             |
| [CO-04](./CO-04_DECISION_RIGHTS.ja.md)          | 意思決定権限マトリクス(decision rights as data・承認ゲート統合・黄金律タイブレーク)    | P2     | M    | CO-01,CO-02,SA-05                       |
| [CO-05](./CO-05_BUSINESS_PROCESS_LIBRARY.ja.md) | 事業プロセステンプレートの拡充(採用/財務決算/調達/取締役会/資金調達)                   | P2     | M    | MO-01,CO-02,CO-03                       |
| [CO-06](./CO-06_SOLOPRENEUR_AI_WORKFORCE.ja.md) | ソロプレナーAI workforce(人とAIの共通労働契約・人間への最終帰責・委任lease・CEO操作面) | **P0** | L    | CO-01,CO-04,MO-03,OP-01,SU-01〜04,SA-05 |

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
Wave 1 (即時・並行可): IP-01 → IP-02, IP-03, IP-04, IP-13, UX-01, UX-06, KM-01, KM-04, AC-01, MO-01, AA-01, SA-01, OP-02, ONB-01, ONB-02
Wave 2:                IP-07, IP-05, IP-06, UX-02, UX-04, AC-02, KM-03, MO-02, MO-04, DS-01, AA-02, AA-03, SA-02, SA-04, OP-01, IL-01, ONB-03, HO-01, QA-01 Phase 1
Wave 3:                IP-08, IP-09, IP-12, IP-14, UX-03, AC-03, AC-04, KM-02, MO-03, MO-06, DS-02, DS-03, AA-04, SA-03, SA-05, OP-03, OP-04, IL-02, IL-04, MO-07, SU-01, SU-02, SU-03, QA-01 Phase 2-4
Wave 4 (継続的):       IP-10, IP-11, UX-05, AC-05, AC-06, MO-05, DS-04, DS-05, AA-05, OP-05, IL-03, IL-05, SU-04, HO-02
```

HN 系の推奨: **HN-02(schema-forced 委譲)を Wave 2**(MO-04 と同時。軽量モデル活用と出力検証の前提)、**HN-01 を Wave 3**(MO-05 の後)、**HN-03 を Wave 3〜4**(MO-03 の後、workflow-as-code は SA-02 完了後)。参照文書 ORCHESTRATION_HARNESS_MODEL は思想の正本として随時参照。

AO 系の推奨: **AO-03(デーモン監督・エスカレーション)を Wave 1**(無人運用の前提。死んでも気づかない/戻らない状態の解消が最優先)、**AO-02(依存/脆弱性パッチ)を Wave 2**(無人運用の最大リスク)、**AO-01(自律保守ループ)を Wave 2〜3**(KM-01 の GC 配線と協調)、**AO-04(soak 検証)を Wave 3〜4**(AO-01/02/03 が安定してから)。判断の正本は AUTONOMOUS_MAINTENANCE_JUDGMENT。

> **セキュリティ P0 の実施順**: SA-02(シェル/ADF ガードレールの判定エンジン)と SA-04(egress ポリシー)を先に確定し、SA-05(kill-switch 配線・全ゲートの fail-closed 化)がそれらを配線する。SA-01(監査完全性)は独立に先行可能。fail-open → fail-closed の切替はいずれも warn 観測期間を挟む。
>
> **インテント縦串の実施順**: IL-01(goal 貫通)が IL-02/03/04 と SU-01・HO-01 の前提。ONB-01(スタブ脳解消)は初回体験の最優先で Wave 1。SU 系(UI)は IL-01/04・MO-07 の後段が価値を出す。

各 IP は独立したブランチ/パッチ単位で完結させる。1つの IP 内でもタスク単位でコミットを分け、`pnpm lint && pnpm typecheck && pnpm test:unit` を各コミットで通すこと。

## 6. 共通の作業規約(全 IP 共通・実装エージェントへの指示)

1. **ファイル I/O は必ず `@agent/core/secure-io` 経由**(AGENTS.md §1)。この計画の実装作業自体も不変条件に従うこと。
2. 変更前に対象ファイルを必ず読み、この計画に記載の行番号が現状とずれていれば現状を正とする(行番号は 2026-07-02 時点)。
3. テストを先に緑で確認 → 変更 → 同テストが緑のままであることを確認、の順で進める。
4. 挙動を変える判断(fail-open → fail-closed 等)は計画に明記がない限り行わず、TODO コメントと本計画への参照を残して報告する。
5. 一時ファイルは `active/shared/tmp/` のみ使用。
