---
title: Supported Actuators Catalog / サポートアクチュエータ一覧
category: Orchestration
tags: [orchestration, actuators, capabilities, bilingual]
importance: 9
author: Antigravity
last_updated: 2026-10-18
---

# Supported Actuators Catalog / サポートアクチュエータ一覧

This document provides a comprehensive bilingual catalog of all official **Actuators** supported by the Kyberion platform, which define the host-native, browser, and AI execution capabilities of the agent ecosystem.

この文書は、Kyberion プラットフォームが公式にサポートするすべての **アクチュエータ（実行モジュール）** の一覧と詳細を定義した日英バイリンガルのカタログです。アクチュエータは、エージェントがホストOS、ブラウザ、AI生成環境などを安全に操作するためのコア能力を定義します。

For day-to-day routing, start with the quick map below. The full catalog stays as the authoritative appendix.

---

## 1. Media and Interaction Quick Map / メディア・対話ルーティング早見表

| Intent                    | Preferred Service / Preset                                                                           | Primary Actuators                                                   |
| :------------------------ | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| `generate-video`          | `media-generation` / `service-presets/media-generation.json`                                         | `media-generation-actuator`, `artifact-actuator`                    |
| `transcribe-audio`        | `whisper` / `service-presets/whisper.json`                                                           | `wisdom-actuator`, `artifact-actuator`                              |
| `live-voice`              | `voice` + `whisper` / `service-presets/voice.json`, `service-presets/whisper.json`                   | `voice-actuator`, `wisdom-actuator`, `artifact-actuator`            |
| `generate-narrated-video` | `voice` + `media-generation` / `service-presets/voice.json`, `service-presets/media-generation.json` | `voice-actuator`, `video-composition-actuator`, `artifact-actuator` |
| `meeting-operations`      | `meeting` / `service-presets/meeting.json`                                                           | `meeting-actuator`, `meeting-browser-driver`, `wisdom-actuator`     |

## 2. Directory of Official Actuators / アクチュエータ公式カタログ一覧

Synced from `libs/actuators/*/manifest.json` — 37 manifest-backed actuators as of 2026-10-18.
`libs/actuators/*/manifest.json` から同期。2026-10-18 時点で 37 件の manifest 付きアクチュエータが存在します。

| Actuator ID / 識別子             | Version / バージョン | Contract Schema / 契約スキーマ            | Description (EN)                                                                                                                                                   | 説明 (JA)                                                                                                                   |
| :------------------------------- | :------------------: | :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **`agent-actuator`**             |        1.1.0         | `agent-action.schema.json`                | Meta-Actuator for agent lifecycle, sub-agent spawning, and A2A routing.                                                                                            | エージェントのライフサイクル管理、サブエージェント起動、A2A 通信制御。                                                      |
| **`android-actuator`**           |        1.1.0         | `mobile-device-pipeline.schema.json`      | Android device control: ADB pipeline plus Android CLI (UI tree, screen capture/resolve, docs search).                                                              | ADB パイプラインと Android CLI による実機/エミュレータ操作、UI 構造解析、画面取得。                                         |
| **`approval-actuator`**          |        1.1.0         | `approval-action.schema.json`             | Human approval request state transitions and decision handling.                                                                                                    | 人間オペレーターへの承認要求の状態遷移と決定記録。                                                                          |
| **`artifact-actuator`**          |        1.0.0         | `artifact-action.schema.json`             | Governed artifact and delivery-pack assembly, validation, and signing.                                                                                             | ガバナンス付き成果物・デリバリーパックの編成、検証、署名。                                                                  |
| **`blockchain-actuator`**        |        1.1.0         | `blockchain-action.schema.json`           | Local ledger anchoring for evidence records.                                                                                                                       | 証跡レコードをローカル台帳にアンカーする境界。                                                                              |
| **`browser-actuator`**           |        1.2.0         | `browser-automation-pipeline.schema.json` | Pipeline-driven Playwright browser execution and session artifacts.                                                                                                | Playwright によるパイプライン駆動のブラウザ実行とセッション成果物。                                                         |
| **`build-actuator`**             |        1.1.0         | `build-pipeline.schema.json`              | iOS/Android build, test, archive and app scaffolding — the build stage of the mobile AI-DLC/SDLC loop.                                                             | iOS/Android のビルド・テスト・アーカイブ・雛形生成。モバイル AI-DLC/SDLC ループのビルド段。                                 |
| **`calendar-actuator`**          |        1.5.0         | `calendar-action.schema.json`             | Adapter-based calendar coordination: macOS Calendar.app (JXA) and authenticated Google Workspace (gws).                                                            | アダプター式カレンダー連携。macOS「カレンダー」(JXA) と認証済み Google Workspace に対応。                                   |
| **`code-actuator`**              |        2.2.0         | `code-pipeline.schema.json`               | ADF-driven code analysis and refactoring pipeline engine.                                                                                                          | ADF 駆動のコード解析・リファクタリングパイプラインエンジン。                                                                |
| **`compute-actuator`**           |        1.0.0         | `-`                                       | Remote/local compute orchestration for heavy batch workloads, fine-tuning, and model execution (e.g. Google Colab).                                                | 重いバッチ処理・ファインチューニング・モデル実行のためのリモート/ローカル計算基盤オーケストレーション(Google Colab 等)。    |
| **`data-actuator`**              |        1.1.0         | `data-action.schema.json`                 | Offline deterministic tabular ops over local JSON/CSV (query, filter, join, aggregate).                                                                            | ローカル JSON/CSV へのオフライン決定論的テーブル操作(クエリ・フィルタ・結合・集約)。                                        |
| **`deployment-actuator`**        |        1.1.0         | `deployment-action.schema.json`           | Deployment capability boundary backed by the governed DeploymentAdapter.                                                                                           | ガバナンス付き DeploymentAdapter を介したデプロイ境界。                                                                     |
| **`email-actuator`**             |        1.2.0         | `email-action.schema.json`                | Adapter-based email composition and sending via macOS Mail.app (JXA) or SMTP.                                                                                      | macOS「メール」(JXA) または SMTP によるメール作成・送信。                                                                   |
| **`file-actuator`**              |        1.1.0         | `file-pipeline.schema.json`               | Generic file CRUD and discovery pipeline.                                                                                                                          | 汎用ファイル CRUD・探索パイプライン。                                                                                       |
| **`ingest-actuator`**            |        1.2.0         | `-`                                       | Ingest pipeline: unstructured documents (docx/pdf/xlsx/html/slack) into governed knowledge cards with watermark sync and commit ceremony.                          | 非構造文書をガバナンス付きナレッジカード化する取り込みパイプライン(水位線同期・コミット儀式付き)。                          |
| **`ios-actuator`**               |        1.1.0         | `mobile-device-pipeline.schema.json`      | simctl-driven iOS simulator control and UI testing.                                                                                                                | `simctl` 駆動の iOS シミュレータ操作・UI 自動テスト。                                                                       |
| **`media-actuator`**             |        1.2.0         | `media-pipeline.schema.json`              | Document/asset generation engine: native pdf/pptx/docx/xlsx readers plus template-inheriting partial updates.                                                      | ドキュメント/アセット生成エンジン。ネイティブ読み取りとテンプレート継承の部分更新。                                         |
| **`media-generation-actuator`**  |        1.4.0         | `media-generation-action.schema.json`     | Generative image, video, music, and screen-capture boundary.                                                                                                       | 画像・動画・音楽の生成と画面キャプチャの境界。                                                                              |
| **`meeting-actuator`**           |        1.3.0         | `meeting-action.schema.json`              | Layered online-meeting bridge (Zoom/Teams/Meet): session transport plus intelligence (action items, facilitation); browser join lives in `meeting-browser-driver`. | オンライン会議ブリッジ(Zoom/Teams/Meet)。セッション制御とインテリジェンスを統合。ブラウザ入室は `meeting-browser-driver`。  |
| **`meeting-browser-driver`**     |        1.0.0         | `-`                                       | Internal Playwright join driver for web meetings; writes captured audio to an AudioBus.                                                                            | Web 会議への内部 Playwright 入室ドライバ。AudioBus へ会議音を出力。                                                         |
| **`modeling-actuator`**          |        1.1.0         | `modeling-pipeline.schema.json`           | Architectural analysis and ADF transformation engine.                                                                                                              | アーキテクチャ分析と ADF 変換エンジン。                                                                                     |
| **`network-actuator`**           |        2.2.0         | `network-pipeline.schema.json`            | ADF-driven secure fetch and signed A2A transport pipelines.                                                                                                        | ADF 仕様のセキュア HTTP 通信・署名付き A2A 転送パイプライン。                                                               |
| **`orchestrator-actuator`**      |        1.0.0         | `orchestrator-pipeline.schema.json`       | Mission/control-plane transformation and execution-plan orchestration.                                                                                             | ミッション/制御プレーンの変換と実行計画オーケストレーション。                                                               |
| **`presence-actuator`**          |        1.0.0         | `presence-action.schema.json`             | Human presence verification and messaging bridge.                                                                                                                  | 人間の在席確認とメッセージングブリッジ。                                                                                    |
| **`process-actuator`**           |        1.0.0         | `process-action.schema.json`              | Managed process lifecycle backed by the runtime supervisor.                                                                                                        | ランタイムスーパーバイザ管理下のプロセスライフサイクル。                                                                    |
| **`scheduler-actuator`**         |        1.1.0         | `scheduler-action.schema.json`            | Declaration-only schedule store (cron declarations under `active/shared/runtime/scheduler/`); no daemonization.                                                    | cron 宣言の保存のみを行うスケジュールストア(デーモン化なし)。実行は別ランナーが担当。                                       |
| **`search-actuator`**            |        1.0.0         | `search-action.schema.json`               | Query-origin web search and plain-text URL reader; transport stays in `network-actuator`.                                                                          | 検索クエリ起点と URL テキスト取得。転送は `network-actuator` が担当。                                                       |
| **`secret-actuator`**            |        1.2.0         | `secret-action.schema.json`               | OS-native secret manager bridge; prefer `kyberion secret introduce` / Concierge for value collection.                                                              | OS ネイティブ秘密管理ブリッジ。値の登録は `kyberion secret introduce` / Concierge 経由。                                    |
| **`service-actuator`**           |        1.3.0         | `service-action.schema.json`              | Unified external SaaS/API/MCP reachability layer.                                                                                                                  | 外部 SaaS・API・MCP への統一到達レイヤー。                                                                                  |
| **`system-actuator`**            |        1.12.0        | `system-pipeline.schema.json`             | OS-level control plane: diagnostics, input toggles, and short-lived OS actions.                                                                                    | OS 制御プレーン。診断・入力切替・短命な OS 操作。                                                                           |
| **`terminal-actuator`**          |        1.0.0         | `terminal-action.schema.json`             | PTY-driven interactive terminal sessions.                                                                                                                          | PTY 駆動の対話型ターミナルセッション。                                                                                      |
| **`vcs-actuator`**               |        1.2.0         | `vcs-action.schema.json`                  | Governed VCS surface: git lifecycle (status/diff/log/branch/commit/push/fetch/pull/checkout/worktree) plus GitHub PR ops via `gh`.                                 | ガバナンス付き VCS 面。git 操作一式と `gh` 経由の GitHub PR 操作。                                                          |
| **`video-composition-actuator`** |        1.2.0         | `-`                                       | Governed deterministic composed-video bundle preparation.                                                                                                          | 決定論的な合成動画バンドル準備(ガバナンス付き)。                                                                            |
| **`vision-actuator`**            |        1.5.0         | `vision-action.schema.json`               | Perception-oriented compatibility facade; generation and screen capture live in `media-generation-actuator`.                                                       | 知覚向け互換ファサード。生成・画面キャプチャは `media-generation-actuator` 側。                                             |
| **`voice-actuator`**             |        1.8.0         | `voice-action.schema.json`                | Governed local voice generation, native playback, and voice-profile workflows.                                                                                     | ガバナンス付きローカル音声生成・再生・ボイスプロフィール。                                                                  |
| **`wisdom-actuator`**            |        1.7.0         | `wisdom-action.schema.json`               | Knowledge-tier search, injection, import/export, and decision support.                                                                                             | ナレッジ層の検索・注入・インポート/エクスポート・意思決定支援。                                                             |
| **`working-memory-actuator`**    |        1.3.0         | `working-memory-action.schema.json`       | Volatile knowledge layer: MEMORY.md / NOW.md / daily journal / weekly review / TODO with CRUD+GC; dispatched as domain `working-memory`.                           | 揮発性ナレッジ層(MEMORY.md/NOW.md/日誌/週次レビュー/TODO)の CRUD+GC。パイプラインでは `working-memory` ドメインとして配送。 |

---

## 2.5 Which Document Answers Which Question / どの文書が何に答えるか

The agent ↔ actuator boundary spans several documents. Use this map instead of searching:

エージェント ↔ アクチュエータの境界は複数文書にまたがります。検索する前にこのマップを使ってください。

| Question / 問い                                           | Document                                                               |
| :-------------------------------------------------------- | :--------------------------------------------------------------------- |
| Who interprets vs who executes (LLM ↔ ADF ↔ actuator)     | [llm-execution-boundary.md](../architecture/llm-execution-boundary.md) |
| Which actuator, which contract shape, which schema        | [actuator-contract-map.md](../architecture/actuator-contract-map.md)   |
| How ops should be shaped (physical / transform / control) | [actuator-op-taxonomy.md](../architecture/actuator-op-taxonomy.md)     |
| Taking input in: `read` / `see` / `listen` / `watch`      | [perception-playbook.md](./perception-playbook.md)                     |
| Acting by target: browser / desktop / terminal / voice    | [action-playbook.md](./action-playbook.md)                             |
| Trying an op: discover → check → dry-run → live           | [actuator-agent-usage.md](./actuator-agent-usage.md)                   |
| From a successful run to a registered pipeline            | [actuator-to-pipeline-flow.md](./actuator-to-pipeline-flow.md)         |
| Choosing the narrowest executor (native op ladder)        | [native-op-ladder.md](./native-op-ladder.md)                           |
| Which capabilities have a single verb and which do not    | [capability-verb-inventory.md](./capability-verb-inventory.md)         |
| Where runtime files may live under `active/`              | [runtime-storage-layout.md](../architecture/runtime-storage-layout.md) |
| Full op tables per actuator (generated)                   | [CAPABILITIES_GUIDE.md](../../../CAPABILITIES_GUIDE.md)                |

---

## 3. Three-Tier Safety Architecture / 3レイヤーの実行安全設計

Every actuator is subject to the **Kyberion Security Shield** to prevent unauthorized command execution or resource leakages:
各アクチュエータは、不正なコマンド実行やリソースのリークを防ぐため、**Kyberion セキュリティ・シールド**の監視下で安全に実行されます。

1.  **Contract Verification (Static) / 契約スキーマ検証**
    - Parameters are strictly validated against JSON Schemas (`contract_schema`) before execution begins.
    - 実行前に、受け取ったパラメータが JSON スキーマと完全に一致するかを厳密に静的検証。
2.  **OS Permission Isolation (Runtime) / OSアクセス権限の隔離**
    - Desktop and hardware integrations (Camera, Screen Recording, Contacts, Calendar) are isolated via standard macOS/Linux sandboxes and require user-explicit approval.
    - デスクトップ操作やハードウェア連携は、OS標準のサンドボックス制限に基づき、実行時にオペレーターによる明示的なシステム権限許可が必要。
3.  **Active Execution Supervision (Daemon) / デーモンによる実行監視**
    - Managed processes are registered within `runtimeSupervisor` and tied to execution leases (`expires_at`), automatically terminating runaway subprocesses.
    - 起動したプロセスはすべて `runtimeSupervisor` に登録され、リース期限切れや異常発生時に自動で強制終了（自己回復）を実行。

---

> [!NOTE]
> Detailed command-line triggers and JSON execution examples are compiled in [CAPABILITIES_GUIDE.md](../../../CAPABILITIES_GUIDE.md).
> 各アクチュエータの具体的なコマンドパラメータや JSON パイプライン例は、[CAPABILITIES_GUIDE.md](../../../CAPABILITIES_GUIDE.md) に網羅されています。
