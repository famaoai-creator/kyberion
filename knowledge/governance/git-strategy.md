# GIT Strategy: Sovereign Hierarchical Synchronization

本ドキュメントは、Gemini エコシステムにおける Git 管理の基本理念と、機密性と透明性を両立させるための階層的同期モデル（Sovereign Git Strategy）について定義する。

## 1. 階層的ナレッジ・モデル (Triple-Tier Model)

情報の機密レベルに応じて、異なる Git 同期戦略を適用する。

| ティア | ディレクトリ | 機密レベル | Git 同期戦略 |
| :--- | :--- | :--- | :--- |
| **Public** | `knowledge/` | 公開可能 | **メインモノレポ**: コミュニティ全体で共有される標準知識。 |
| **Confidential** | `knowledge/confidential/` | 組織内秘 | **Sovereign-Sync**: 独立したプライベート・リポジトリと個別に同期。 |
| **Personal** | `knowledge/personal/` | 個人専用 | **完全隔離**: `.gitignore` により Git 管理から除外。ローカルのみに存在。 |

## 2. Sovereign-Sync プロトコル

特定のティア（主に Confidential）を、モノレポの構造を維持したまま外部リポジトリと同期させる仕組み。

- **目的**: 組織ごとの秘匿情報を、コアシステムのアップデートから切り離して管理する。
- **実装**: 物理ディレクトリを Git サブモジュール、または独立した Git ルートとして扱い、専用の同期スキルを通じて Push/Pull を行う。

## 3. Dual-Key ガバナンス

AI エージェントによる Git 操作（Commit/Push）に対する制約。

- **原則**: AI は自律的に Commit は行うが、Push は原則として「主権者（人間）」の明示的な承認を必要とする。
- **目的**: 誤った情報の外部流出や、リポジトリ履歴の汚染を防止する。
- **承認フロー**: `consensus.json` によるロール間合意形成の後、主権者の `sudo` ゲートを経て実行される。

## 4. Tier-Guard (物理防壁)

情報の「越境」を防止する物理的・論理的ガードレール。

- **`.gitignore` による保護**: Personal ティアや `vault/`（原典データ）が誤って Git ステージングされないよう厳格に設定。
- **Build Artifacts**: `dist/` や `node_modules` は Git 管理外とし、常にソース（TypeScript）から生成される環境を維持する。

## 5. Delivery Flow (Safe Git Flow)

- **Branching**: すべての作業は `feat/`, `fix/`, `docs/` などの機能ブランチで行う。
- **Atomic Commits**: 1つのタスク（マイクロタスク）ごとにコミットを行い、トレーサビリティを確保する。
- **Evidence Binding**: コミットメッセージには、その変更の根拠となった `active/missions/` の ID や ROI 情報を可能な限り含める。
