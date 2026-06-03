---
title: Supported Actuators Catalog / サポートアクチュエータ一覧
category: Orchestration
tags: [orchestration, actuators, capabilities, bilingual]
importance: 9
author: Antigravity
last_updated: 2026-05-31
---

# Supported Actuators Catalog / サポートアクチュエータ一覧

This document provides a comprehensive bilingual catalog of all official **Actuators** supported by the Kyberion platform, which define the host-native, browser, and AI execution capabilities of the agent ecosystem.

この文書は、Kyberion プラットフォームが公式にサポートするすべての **アクチュエータ（実行モジュール）** の一覧と詳細を定義した日英バイリンガルのカタログです。アクチュエータは、エージェントがホストOS、ブラウザ、AI生成環境などを安全に操作するためのコア能力を定義します。

For day-to-day routing, start with the quick map below. The full catalog stays as the authoritative appendix.

---

## 1. Media and Interaction Quick Map / メディア・対話ルーティング早見表

| Intent | Preferred Service / Preset | Primary Actuators |
| :--- | :--- | :--- |
| `generate-video` | `media-generation` / `service-presets/media-generation.json` | `media-generation-actuator`, `artifact-actuator` |
| `transcribe-audio` | `whisper` / `service-presets/whisper.json` | `wisdom-actuator`, `artifact-actuator` |
| `live-voice` | `voice` + `whisper` / `service-presets/voice.json`, `service-presets/whisper.json` | `voice-actuator`, `wisdom-actuator`, `artifact-actuator` |
| `generate-narrated-video` | `voice` + `media-generation` / `service-presets/voice.json`, `service-presets/media-generation.json` | `voice-actuator`, `video-composition-actuator`, `artifact-actuator` |
| `meeting-operations` | `meeting` / `service-presets/meeting.json` | `meeting-actuator`, `meeting-browser-driver`, `wisdom-actuator` |

## 2. Directory of Official Actuators / アクチュエータ公式カタログ一覧

| Actuator ID / 識別子 | Version / バージョン | Contract Schema / 契約スキーマ | Description (EN) | 説明 (JA) |
| :--- | :---: | :--- | :--- | :--- |
| **`agent-actuator`** | 1.0.0 | `agent-action.schema.json` | Meta-Actuator for managing agent lifecycles, sub-agents, and A2A routing. | エージェントのライフサイクル管理、サブエージェントの起動、および A2A 通信制御。 |
| **`system-actuator`** | 1.2.0 | `system-pipeline.schema.json` | OS control plane for diagnostics, input toggles, and short-lived OS actions. | OSレベルの制御プレーン。診断、入力切替、一時的な OS 操作を担当。 |
| **`browser-actuator`** | 1.0.0 | `browser-pipeline.schema.json` | Pipeline-driven Playwright automated browser sessions and scraping. | Playwright を用いた Web ブラウザの自律巡回、データ抽出、およびセッション制御。 |
| **`terminal-actuator`** | 1.0.0 | `-` | PTY-driven Terminal emulator for highly managed interactive shell operations. | PTY（擬似端末）を介した、安全に監視された対話型シェルセッションの操作。 |
| **`process-actuator`** | 1.0.0 | `process-action.schema.json` | Background process supervisor, lifecycle hooks, and process management. | ランタイムスーパーバイザの管理下におけるプロセス生存期間の監視・制御。 |
| **`secret-actuator`** | 1.1.0 | `secret-action.schema.json` | Bridge to OS native credential vaulting (e.g. macOS Keychain). | macOS キーチェーンなどの OS ネイティブなセキュア鍵ストアとのブリッジ。 |
| **`service-actuator`** | 1.1.0 | `service-action.schema.json` | Unified external SaaS, REST API, and MCP server connectivity gateway. | 外部 SaaS、REST API、および MCP（Model Context Protocol）との中継接続。 |
| **`voice-actuator`** | 1.2.0 | `voice-action.schema.json` | Local voice synthesis, playback, and voice-profile workflows. | ローカル音声合成（TTS）、再生、ボイスプロフィール管理。 |
| **`video-composition-actuator`** | 1.0.0 | `-` | Deterministic video clip composition, slide-to-video, and audio muxing. | 音声ナレーション、画像、字幕テロップを結合した説明用動画の自動編集・作成。 |
| **`media-generation-actuator`** | 1.1.0 | `media-generation-action.schema.json` | Generative image, video, music, and screen-capture boundary. | 画像・音楽・動画の生成と画面取得の境界。 |
| **`media-actuator`** | 1.1.0 | `media-pipeline.schema.json` | Document and asset composition/rendering with template-aware updates. | ドキュメントとアセットの組版・レンダリング、およびテンプレート対応の更新。 |
| **`meeting-actuator`** | 1.0.0 | `meeting-action.schema.json` | Abstracted online meeting bridge for Zoom, Teams, and Google Meet; browser join backend lives in `meeting-browser-driver`. | オンライン会議（Meet / Zoom / Teams）への接続、参加時間および制御の抽象化。ブラウザ入室は `meeting-browser-driver` に分離。 |
| **`meeting-browser-driver`** | 1.0.0 | `-` | Internal Playwright join driver for web meetings with real-time AudioBus capture. | オンライン会議への内部ブラウザ入室ドライバと、音声バス経由の会議音取得。 |
| **`code-actuator`** | 2.1.0 | `code-pipeline.schema.json` | ADF-driven code analysis, refactoring, and code generation parser. | ADF駆動のコードの構文解析、自動リファクタリング、およびコード生成。 |
| **`modeling-actuator`** | 1.0.0 | `modeling-pipeline.schema.json` | Architectural analysis and ADF translation / conversion engine. | アーキテクチャ構成分析、システム構成図の生成、および ADF 設計図の相互変換。 |
| **`network-actuator`** | 2.2.0 | `network-pipeline.schema.json` | ADF-driven secure HTTP fetch and signed A2A message transport pipelines. | ADF仕様に基づくセキュアな HTTP 通信および署名付きピア間通信の実行。 |
| **`orchestrator-actuator`** | 1.0.0 | `orchestrator-pipeline.schema.json` | Execution-plan orchestration, DAG resolving, and mission scheduling. | ミッション・コントロールプレーンの計画編成、DAG依存関係の解決・スケジュール。 |
| **`approval-actuator`** | 1.0.0 | `approval-action.schema.json` | Human approval state machine, decision recording, and flow gates. | 人間オペレーターへの承認要求、決定事項の追跡、およびパイプラインの条件付き制御。 |
| **`artifact-actuator`** | 1.0.0 | `artifact-action.schema.json` | Deliverable package assembly, schema validation, and digital signing. | 成果物（Artifact）パッケージの編成、デジタル署名、およびリリース版検品。 |
| **`wisdom-actuator`** | 1.2.1 | `wisdom-action.schema.json` | Knowledge search, RAG, vector/metadata filtering, and import/export. | ナレッジベース（RAG）の類似検索、インポート・エクスポート、意思決定支援。 |
| **`presence-actuator`** | 1.0.0 | `presence-action.schema.json` | Human presence verification and messaging notifications. | 人間の在席・稼働状況（Presence）の確認、および緊急アラート通知。 |
| **`calendar-actuator`** | 1.0.0 | `calendar-action.schema.json` | macOS Calendar.app scheduling and coordination via JXA scripts. | macOS「カレンダー.app」の読み書き、イベント調整、およびスケジュール調整。 |
| **`email-actuator`** | 1.0.0 | `email-action.schema.json` | macOS Mail.app (JXA) or SMTP email creation and dispatch. | 「メール.app」または SMTP（Nodemailer）を介した電子メール作成・送信。 |
| **`android-actuator`** | 1.1.0 | `mobile-device-pipeline.schema.json` | Android device control, ADB commands, UI tree parsing, and testing. | Androidエミュレータ/実機の自動操作、ADB操作、UI構造解析、自律テスト。 |
| **`ios-actuator`** | 1.1.0 | `mobile-device-pipeline.schema.json` | Xcode simulator (`simctl`) management, iOS UI automated testing. | iOSシミュレータの起動、Xcode `simctl` 連携、iOS上でのUI自動テスト。 |
| **`blockchain-actuator`** | 1.0.0 | `blockchain-action.schema.json` | Cryptographic evidence anchoring and immutable ledger registration. | 生成された成果物のハッシュ署名をブロックチェーンに書き込む監査証跡システム。 |
| **`vision-actuator`** | 1.3.0 | `vision-action.schema.json` | Perception-oriented compatibility facade; inspect_image and ocr_image are the canonical public ops. | 視覚認識向けの互換ファサード。公開 op は inspect_image / ocr_image を中心に維持。 |

---

## 3. Three-Tier Safety Architecture / 3レイヤーの実行安全設計

Every actuator is subject to the **Kyberion Security Shield** to prevent unauthorized command execution or resource leakages:
各アクチュエータは、不正なコマンド実行やリソースのリークを防ぐため、**Kyberion セキュリティ・シールド**の監視下で安全に実行されます。

1.  **Contract Verification (Static) / 契約スキーマ検証**
    *   Parameters are strictly validated against JSON Schemas (`contract_schema`) before execution begins.
    *   実行前に、受け取ったパラメータが JSON スキーマと完全に一致するかを厳密に静的検証。
2.  **OS Permission Isolation (Runtime) / OSアクセス権限の隔離**
    *   Desktop and hardware integrations (Camera, Screen Recording, Contacts, Calendar) are isolated via standard macOS/Linux sandboxes and require user-explicit approval.
    *   デスクトップ操作やハードウェア連携は、OS標準のサンドボックス制限に基づき、実行時にオペレーターによる明示的なシステム権限許可が必要。
3.  **Active Execution Supervision (Daemon) / デーモンによる実行監視**
    *   Managed processes are registered within `runtimeSupervisor` and tied to execution leases (`expires_at`), automatically terminating runaway subprocesses.
    *   起動したプロセスはすべて `runtimeSupervisor` に登録され、リース期限切れや異常発生時に自動で強制終了（自己回復）を実行。

---

> [!NOTE]
> Detailed command-line triggers and JSON execution examples are compiled in [CAPABILITIES_GUIDE.md](file:///Users/famao/kyberion/CAPABILITIES_GUIDE.md).
> 各アクチュエータの具体的なコマンドパラメータや JSON パイプライン例は、[CAPABILITIES_GUIDE.md](file:///Users/famao/kyberion/CAPABILITIES_GUIDE.md) に網羅されています。
