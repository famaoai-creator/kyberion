---
title: Supported External Integrations & Services / 外部連携サービス一覧
category: Connections
tags: [connections, integrations, saas, api, mcp, bilingual]
importance: 8
author: Antigravity
last_updated: 2026-05-31
---

# Supported External Integrations & Services / 外部連携サービス一覧

This document provides a comprehensive bilingual catalog of all external services and SaaS integrations officially supported by the Kyberion platform, as defined in `service-endpoints.json`.

この文書は、Kyberion プラットフォームが公式にサポートするすべての外部サービスおよび SaaS 連携の一覧と詳細を定義した日英バイリンガルのカタログです。

---

## 1. Directory of Supported Services / サポートサービス一覧

| Service ID / サービスID | Category / カテゴリー | Credentials & Envs / 必要な認証情報・環境変数 | Description (EN) | 説明 (JA) |
| :--- | :--- | :--- | :--- | :--- |
| **`github` / `github-mcp`** | Dev / BTS | `GITHUB_TOKEN` / `ACCESS_TOKEN` | Repositories, Issue syncing, Pull Requests, code operations, and MCP tools. | リポジトリ操作、Issue連携、Pull Request、コード監査、および MCP ツール連携。 |
| **`jira`** | Dev / BTS | `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Atlassian Jira issue creation, status transitions, and workspace syncing. | Atlassian Jira チケットの作成、ステータス変更、およびカンバン同期。 |
| **`linear`** | Dev / BTS | `LINEAR_API_KEY` | GraphQL-based issue query, creation, and workflow management. | GraphQL駆動の課題取得・作成、およびチケットワークフロー管理。 |
| **`backlog`** | Dev / BTS | `BACKLOG_SPACE`, `BACKLOG_API_KEY` | Nulab Backlog project boards, task tracking, and API v2 synchronization. | ヌーラバー社 Backlog 課題の取得・作成、タスク追跡、API v2 連携。 |
| **`gitlab`** | Dev / BTS | `GITLAB_HOST`, `GITLAB_TOKEN` | GitLab repository management, Merge Requests, and pipeline monitoring. | GitLab リポジトリ管理、マージリクエスト操作、CI/CD パイプライン監視。 |
| **`zendesk`** | Dev / BTS | `ZENDESK_SUBDOMAIN`, `ZENDESK_TOKEN` | Customer support ticket querying, replies, and status lifecycle. | Zendesk サポートチケットの作成、回答、ステータスライフサイクル同期。 |
| **`slack`** | Messaging | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Slack channel messaging, notifications, and interactive Socket Mode gateway. | Slack チャネル送信、ステータス通知、Socket Mode ゲートウェイ連携。 |
| **`discord`** | Messaging | `DISCORD_TOKEN`, `DISCORD_WEBHOOK_URL` | Discord channel messaging, notifications, and webhook triggers. | Discord チャネルメッセージ送信、ステータス通知、ウェブフック連携。 |
| **`telegram`** | Messaging | `TELEGRAM_TOKEN` | Telegram Bot API messaging, channel post, and incoming updates retrieve. | Telegram Bot API を介したチャットメッセージ送受信、チャンネル投稿。 |
| **`notion`** | Workspace | `NOTION_API_KEY` | Notion database CRUD, page creation, and knowledge base syncing. | Notion データベース操作、Wiki ページの自動起票、ナレッジ同期。 |
| **`confluence`** | Workspace | `CONFLUENCE_DOMAIN`, `CONFLUENCE_TOKEN` | Confluence wiki page authoring, design spec syncing, and knowledge retrieval. | Confluence Wiki ページの自動作成、仕様書や設計情報のドキュメント同期。 |
| **`google-workspace`** | Workspace | OAuth Credentials (`client_id`, `client_secret`) | Google Docs, Drive, Sheets, and Slides operations via API/CLI. | Google ドキュメント、スプレッドシート、スライド等の CLI/API 連携。 |
| **`media-generation`** | AI / Creative | Cloud API Keys (e.g. `OPENAI_API_KEY`) | Generative image (DALL-E), music (Suno/Udio), and video assets. | 生成AIを利用したクリエイティブ画像、音楽、動画アセットの自律生成。 |
| **`voice`** | AI / Creative | Voice learning profiles (`user-cloned` etc.) | Cloned voice synthesis, natural text-to-speech, and audio rendering. | クローン音声プロファイルによる自然な音声合成、ナレーション制作。 |
| **`whisper`** | AI / Creative | API Keys or Local model configs | OpenAI Whisper speech-to-text audio transcription. | 音声ファイルのテキスト書き出し（Speech-to-Text）および要約連携。 |
| **`youtube`** | AI / Creative | YouTube Data API Credentials / OAuth | Automated video uploads, metadata (descriptions/tags), and playlisting. | 作成された動画の自動アップロード、メタデータ設定、プレイリスト管理。 |
| **`canva`** | AI / Creative | OAuth client keys | Canva REST API v1 design, template, and asset manipulations. | Canva REST API v1 を介したデザイン、スライド、テンプレートの作成。 |
| **`comfyui`** | AI / Creative | Local pipeline host URL | Stable Diffusion image generation and customized workflow execution. | Stable Diffusion ローカル画像生成ワークフローの自律実行。 |
| **`meeting`** | Collaboration | Playwright / Virtual Audio Device | Google Meet, Zoom, Teams auto-login, audio recording, and meeting sync. | Google Meet, Zoom, Teams 会議への自動参加、会議録音・文字起こし。 |
| **`aws-ce`** | Cloud / FinOps | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS Cost Explorer cost analysis, cost anomaly detection, and reports. | AWS コストエクスプローラーを介したクラウド利用料金の集計・報告。 |
| **`brave-search`** | Search | `BRAVE_SEARCH_API_KEY` | Autonomic search API for real-time web research and knowledge expansion. | リアルタイムな情報収集およびRAG拡張のための自律Web検索。 |
| **`google-maps`** | Utility | `GOOGLE_MAPS_API_KEY` | Geolocation, location searching, and route calculation APIs. | 位置情報の探索、ルート検索、ジオコーディング連携。 |
| **`paper2any`** | Utility | `PAPER2ANY_BASE_URL` | Fast document format conversion (e.g. PDF, slides, markdown). | ドキュメントフォーマット（PDF、スライド等）の高速相互変換。 |
| **`sqlite`** | Utility | Local sqlite path | Structured SQL database queries and storage pipelines. | ローカルの構造化データベース構築、SQLクエリの自律実行。 |
| **`moltbook`** | Custom | Custom API credentials | Moltbook API v1 platform synchronization. | Moltbook API v1 プラットフォーム連携。 |
| **`smoke-test`** | Diagnostic | None / なし | Postman Echo connectivity diagnostics and pipeline testing. | ネットワーク疎通およびパイプライン診断用のエコーテストAPI。 |

---

## 2. Integration Integration Modalities / 連携モードとアプローチ

The platform supports multiple reachability patterns through `service-actuator`:
`service-actuator` は、以下の複数の通信パターンを標準サポートしています。

1.  **PRESET (Pre-configured SDK APIs) / プリセットモード**
    *   Optimized API suites for primary platforms like Slack, GitHub, Jira, and Google.
    *   Slack, GitHub, Jira, Google 等の主要プラットフォームに最適化されたAPIスイート。
2.  **API (Direct Secure Fetch) / 直接APIモード**
    *   Direct HTTP REST requests with automatic credential injection (`Authorization: Bearer`).
    *   ヘッダーへの認証情報自動インジェクションを伴う、直接的な REST API リクエスト。
3.  **CLI (Unsafe CLI Executions) / CLIコマンド実行**
    *   Command line wrappers (gated by `KYBERION_ALLOW_UNSAFE_CLI=true`).
    *   CLIツールの自律実行（セキュリティ保護のため、明示的な有効化が必要）。
4.  **MCP (Model Context Protocol) / MCPツール連携**
    *   Direct tool reachability exposing specialized capabilities from MCP servers.
    *   外部の MCP サーバーが提供する専門ツールをエージェントに直接露出させる連携。
5.  **OAUTH (OAuth 2.0 Auth Broker) / OAuth自動認可**
    *   Managed token acquisition, automatic refresh loops, and secure vault updates.
    *   認可コード交換、トークンの自動リフレッシュ、セキュアなキーチェーン格納。

---

## 3. Storage & Security of Credentials / 認証情報のセキュリティと管理

All sensitive credentials, API keys, and OAuth tokens are strictly isolated in the **Personal Tier** (`knowledge/personal/connections/`) or the local environment file (`.env`), which are git-ignored by default. Under no circumstances are credentials checked into the repository or shared with organization-confidential/public tiers.

外部連携に必要なシークレットや API キー、OAuth トークンなどの機密情報は、Git 管理から除外（`git-ignored`）された **Personal Tier** (`knowledge/personal/connections/`) または環境変数ファイル (`.env`) に厳密に隔離して格納されます。機密情報がパブリックリポジトリや共有ティアに流出することは決してありません。

> [!TIP]
> For step-by-step setup guides, refer to [setup_guide.md](file:///Users/famao/kyberion/knowledge/public/connections/setup_guide.md).
> 段階的なセットアップ手順については、[setup_guide.md](file:///Users/famao/kyberion/knowledge/public/connections/setup_guide.md) をご参照ください。
