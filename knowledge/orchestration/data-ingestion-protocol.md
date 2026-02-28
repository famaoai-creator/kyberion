# The Data Ingestion Protocol (外部データ持ち込み規約)

このドキュメントは、エコシステム（サンドボックス）外部のデータを安全かつ統制された形で内部に取り込むための唯一の公式ルール（Ingestion Vectors）と、取り込んだデータのライフサイクルを定義する。
`tier-guard.cjs` による厳格なサンドボックス境界を維持しつつ、実用的なデータ連携と開発ワークフローを実現するためのプロトコルである。

## 1. 境界防衛の原則 (The Sandbox Principle)

エコシステムのルートディレクトリ外にあるファイルシステム、および未認可の外部ネットワークへの直接アクセスは、システムレベル（`tier-guard.cjs`）で物理的に遮断される。
外部データは、以下の4つの「正規のベクトル（Ingestion Vectors）」のいずれかを経由してのみ、エコシステム内に持ち込むことができる。

## 2. Ingestion Vectors (データ持ち込みの4つのルート)

### Vector 1: Manual Vaulting (主権者による物理的持ち込み)
- **概要**: ユーザー（主権者）自身が、ファイルを `vault/` ディレクトリにコピーして配置する手法。
- **ポリシー**: 全ての「未精査の生データ（Raw Data）」は `vault/` に格納されなければならない。AIエージェントは `vault/` の内容を**読み取り専用**として解釈する。

### Vector 2: Connector Skills (API経由のシステム間連携)
- **概要**: 専用のコネクタスキル（例: `backlog-connector`, `github-connector`）が外部SaaS等からデータを取得する手法。
- **ポリシー**: クレデンシャルは必ず `knowledge/personal/connections/` に保存され、`tier-guard` のアクセス制御に従う。

### Vector 3: Agentic Web Fetching (公開ウェブ情報の取得)
- **概要**: `api-fetcher` や `web_fetch` ツールを用いて、認証不要の公開URLから情報を取得する手法。
- **ポリシー**: 取得対象は公開情報（Public Data）に限定される。取得したデータは「外部の知恵（External Wisdom）」として構造化される。

### Vector 4: The Vault Mount (シンボリックリンクによる動的接続)
- **概要**: 外部の巨大なデータセットやプロジェクトディレクトリを、専用ツール（`vault:mount`）を用いて `vault/mounts/` 配下に接続する手法。
- **ポリシー**: 主権者の明示的なツール実行（Sudo Gate）によってのみ成立する。AIエージェントはこれを `vault/` の一部として扱い、原則として**読み取り専用**で解析・蒸留を行う。

## 3. Sovereign Workspace Model (書き込みの分離)

外部から持ち込んだデータの改変や開発を安全に行うため、以下のワークフローを遵守しなければならない。

### A. Vault is for Reference (原典の保護)
- `vault/` 配下は原則として読み取り専用（Read-only）である。AIはここを直接改変してはならない。
- リポジトリの最新化（`git pull` 等）が必要な場合は、AIは主権者に提案し、明示的な承認（Sudo Gate）を得た上で実行する。これを「Vector 1-B: Original Refresh」と定義する。

### B. Active is for Construction (成果の構築)
- コードの改変、新機能の実装、大規模なリファクタリングを行う場合は、必ず `vault/` から `active/projects/` へ対象ファイルをコピーまたはクローン（checkout）し、そこで作業を行うこと。
- これにより、原典（Vault）を汚染することなく、安全にテストやビルドを実行できる環境（Active Workspace）を確保する。

### C. The Feedback Loop (成果の還元)
- `active/projects/` で完成した変更は、PR（Pull Request）やパッチファイル（`.patch`）として出力される。
- 主権者がその内容をレビューし、承認した場合にのみ、元のリポジトリ（`vault/` またはホスト環境）へ反映（マージ）される。

## 4. The Distillation Mandate (蒸留の義務)

どのVectorを経由してデータが持ち込まれた場合でも、生データ（Raw Data）をそのまま `knowledge/` に書き込んではならない。
エージェントは必ず**「情報の抽出・構造化・秘匿情報のマスキング」**という蒸留プロセスを実行し、純化された知恵（Intel）のみを内部のナレッジベースに永続化しなければならない。
