# Ecosystem Initialization Protocol (Sovereign Onboarding) v1.1

この文書は、新規ユーザー（主権者）が Kyberion エコシステムに参加し、自律的なエージェント環境を構築するための「おもてなし（Omotenashi）」と「物理的初期化」の全工程を定義する。

## 1. 概念的基盤 (The Soul)
初期化は単なるセットアップではなく、**主権者とエージェントの調和フェーズ**である。**Sovereign Concierge** は、主権者が歓迎され、エンパワーされていると感じられるよう、以下のプロトコルを遵守する。

## 2. セットアップ手順 (The 4-Stage Manifestation)

### Phase 1: Identity & Persona (npm run init)
最初のステップは、主権者のアイデンティティの確立である。
- **Action**: `npm run init` を実行する。
- **Content**:
    - 職業ドメイン（エンジニアリング、経営、セールス等）の選択。
    - 具体的なロール（Ecosystem Architect, Strategic Sales 等）の選択。
    - `knowledge/personal/my-identity.json` (魂) の生成。
    - `active/shared/governance/session.json` (状態) の生成。

### Phase 2: Physical Manifestation (npm run build)
エコシステムは TypeScript で記述されており、実行にはコンパイル（脳細胞の生成）が必要である。
- **Action**: `npm install && npm run build` を実行する。
- **Effect**: `dist/` フォルダが生成され、エージェントが各スキルやスクリプトを「反射」的に実行可能になる。
- **Mandate**: `dist/` はソース管理対象外であり、初期化時や更新時には必ず再ビルドが必要である。

### Phase 3: Visionary Sight (npm run vision:start)
エージェントに「現在の状況」を把握させるため、視覚バッファを有効化する。
- **Action**: `npm run vision:start` を実行する。
- **Effect**: `visual-buffer-daemon` が起動し、1秒に1回のペースで画面バッファ（最新10フレーム）を `active/shared/runtime/vision/frames/` に保持し始める。
- **Security**: 撮影はローカルに閉じ、エージェントの推論と自動化の成功判定のみに使用される。

### Phase 4: First Mission (The Navigator)
環境が整ったら、最初の任務を開始する。
- **Action**: `npm run mission:create INITIAL-MAP` を実行する。
- **First Task**: コンシェルジュの案内で `codebase-mapper` を実行し、自分自身の構造をエージェントに教え込む。

## 3. Directory Standard (The Physical Shield)
初期化により、以下の 3-Tier Sovereign Directory が自動生成される：

| ディレクトリ | 役割 |
| :--- | :--- |
| `knowledge/` | AIが解釈・蒸留した「知識資産」。(Public/Confidential/Personal) |
| `vault/` | 参照専用の「原典データ」。(Read-only) |
| `active/` | 現在進行中の設計書、プロトタイプ、開発成果物、ミッションログ。 |
| `scratch/` | 一時的な検証スクリプト。 |
| `presence/` | ターミナル、センサー、ブリッジ等の外部接続層。 |

## 4. Victory Condition
オンボーディングは、主権者が「コンシェルジュの案内なしでも、自分の意志でミッションを組み立て、エビデンスを確認できる」と確信した時点で完了とする。
