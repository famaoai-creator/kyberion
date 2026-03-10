---
title: Terminal Hosting: The Institutional Gateway
category: Architecture
tags: [architecture, terminal, hosting]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Terminal Hosting: The Institutional Gateway

本ドキュメントは、主権者（人間）と AI エージェントが同一の PTY セッションをリアルタイムに共有し、高忠実度な操作環境を実現するための「Institutional Gateway」の設計と実装について定義する。

## 1. ビジョン：共生型ターミナル
単なる「出力の表示」ではなく、ネイティブなシェル環境（PTY）をブラウザへブリッジすることで、以下の価値を提供する。
- **高忠実度**: ANSI カラー、スピナー、日本語入力、リサイズの完全再現。
- **共同作業**: 人間がブラウザからコマンドを入力し、AI がそのセッションを監視・補佐する。
- **ゲートウェイ設計**: 堅牢でモダンな UI を通じた、エコシステムへの唯一の入り口。

## 2. アーキテクチャ

### 2.1 Backend: PTY Engine (`node-pty`)
- **実装**: `libs/core/reflex-terminal.ts`
- **役割**: macOS/Linux の PTY インターフェースを直接叩き、本物のシェルプロセス（bash/zsh）を生成・制御する。
- **進化**: `child_process.spawn` ではなく `node-pty` を採用することで、双方向のインタラクティブ操作を可能にした。

### 2.2 Bridge: WebSocket Server (`ws`)
- **実装**: `presence/bridge/terminal/server.ts`
- **役割**: PTY のバイナリストリームと Web ブラウザ間の低遅延ブリッジ。
- **プロトコル**: JSON 形式のエンベロープ（`type: input/resize`）を採用し、制御命令とデータを分離。

### 2.3 Frontend: Institutional Gateway (UI)
- **実装**: `presence/bridge/terminal/static/index.html`
- **技術**: `xterm.js` + `xterm-addon-fit`
- **デザイン方針**: 
    - ダークモード（`#0d0f14`）基調のインダストリアル・デザイン。
    - **IME フォーカス戦略**: 入力の取りこぼしを防ぐため、クリックやリサイズ時に即座に `term.focus()` を実行。

## 3. 実装上の課題と教訓 (macOS Security)

### 3.1 `posix_spawnp failed` 問題
開発過程で、`node-pty` によるシェル起動が拒絶される現象が発生した。
- **原因**: macOS の TCC (Transparency, Consent, and Control) による制限。
- **教訓**: 親プロセス（iTerm2, Terminal.app, または IDE 自体）に **「フルディスクアクセス (Full Disk Access)」** 権限が付与されていない場合、サンドボックス制限により PTY の生成が物理的に不可能となる。
- **解決策**: OS 設定での明示的な権限付与と、アプリの完全な再起動が不可欠である。

## 4. 運用とガバナンス
- **ポート管理**: デフォルトは `4321`。占有回避のため動的なポート変更（4322, 4323...）をサポート。
- **セッションライフサイクル**: ブラウザ接続時に PTY を生成し、切断（Close）時に確実に `rt.kill()` を実行してゾンビプロセスを防止する。

## 5. Sensory Bridge (Nexus Daemon)
本ターミナルは、単なるユーザーインターフェースを超え、外部センサー（Slack, Voice 等）と AI をつなぐ **「Sensory Bridge」** として機能する。

### 5.1 Nexus Daemon による統合
- **実装**: `presence/bridge/nexus-daemon.ts`
- **フロー**:
    1.  **Stimulus Ingestion**: 外部センサーが `presence/bridge/stimuli.jsonl` に「刺激」を書き込む。
    2.  **Terminal Injection**: Nexus Daemon がアイドル状態のターミナルセッションを特定し、刺激を `[SENSORY_INPUT]` コマンドとして PTY へ直接注入する。
    3.  **Autonomous Execution**: 注入された刺激により AI の思考がトリガーされ、ターミナル上で自律的な処理（スキルの実行等）が開始される。
    4.  **Feedback Mirroring**: 処理結果が `active/shared/last_response.json` に書き出されると、Nexus Daemon がそれを元のソース（Slack 等）へ送り返す。

### 5.2 監査と不揮発性
すべての入力データは `ReflexTerminal` を通じて `active/shared/` へ永続化（Persist）され、エージェントの思考コンテキストとして再利用される。これにより、ターミナルは「AI と外部世界の接点」としての透明性を確保している。
