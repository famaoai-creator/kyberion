# AC-03: デプロイ / CI-CD 実行能力の実体化

> 優先度: P1 / 規模: M / 依存: AC-01(前提条件プローブ)推奨

## 背景と課題

CI/CD・デプロイは需要カタログ上の最大級の領域なのに、実行能力がスタブのまま。

- **需要**: `docs/verification/500_intents_catalog.md` の 500 意図中 **100 が CI/CD ターゲット**(Audit/Generate/Validate/Monitor/Refactor × CI/CD)。`docs/USE_CASES.md` #18「CI/CD の状態確認と対応」は high_stakes 分類。実行時にも `Unsupported pipeline op: system:terraform` が 2 回記録されている(IaC 実行の需要)。
- **供給**: `knowledge/product/pipeline-templates/deploy-release.json` → `wisdom:deploy_release` → `libs/core/deployment-adapter.ts` の `getDeploymentAdapter()` が既定で **`stubDeploymentAdapter`(`status:'dry_run'` を返すだけ)**。実デプロイにはプロジェクト側で `ShellDeploymentAdapter` 等を登録する必要があるが、その登録手順は実質未整備(`wisdom-actuator/src/decision-ops.ts:2614` 経由で確認済み)。
- **関連ギャップ**(evaluation_report): V-4-12 CHANGELOG/リリース自動化 NOT_IMPLEMENTED。modeling-actuator は terraform を**読む**(`terraform_to_architecture_adf`)が **apply はどこにも無い**。
- **設計方針との整合**: deployment-adapter 自身のコメントが「デプロイはプロジェクト固有」と明言しており、汎用 CD 基盤を作るのは方針違反。**「アダプタ登録体験 + GitHub Actions 連携 + リリース補助」の3点に絞る**のが正しいスコープ。

## ゴール(受入条件)

1. リポジトリに `ShellDeploymentAdapter` の登録・設定手順が整備され、サンプル設定で `wisdom:deploy_release` が dry_run ではなく実コマンドを(承認ゲート付きで)実行できる。
2. GitHub Actions の状態確認・workflow dispatch が service preset の op として使える(CI/CD Monitor/Audit 系意図の受け皿)。
3. CHANGELOG 生成 op が存在し、リリースフローのテンプレートから呼べる(V-4-12 解消)。
4. `system:terraform` のような未対応 IaC 要求には、AC-01 のプローブ経由で「未対応。modeling の terraform 読取か shell adapter を使う」という分類済み案内が返る。

## 実装タスク

### Task 1: ShellDeploymentAdapter の登録体験 — `claude-sonnet-4`

1. `libs/core/deployment-adapter.ts` を読み、`ShellDeploymentAdapter` の実装状態を確認する(存在すれば設定経路を、無ければコマンド列+作業ディレクトリ+env を設定ファイルから読む実装を追加)。
2. 設定ファイルの置き場を既存規約に合わせて定義する(例: `knowledge/personal/deployments/<project>.json`、スキーマを `schemas/` に追加)。**デプロイ実行は approval-actuator の承認ゲートを必須にする**(high_stakes)。
3. `deploy-release.json` テンプレートを設定参照型に更新し、設定が無い場合は「dry_run + 設定手順の案内」を返す(現行挙動を劣化させない)。
4. unit test: 設定あり(モック shell)/設定なし/承認未取得の 3 経路。

### Task 2: GitHub Actions 連携 op — `claude-sonnet-4`

1. 既存の `github.json` service preset(8 op 実装済み)に、`actions_list_runs`(workflow run 一覧+結論)、`actions_get_run`(ログ要約用メタ)、`actions_dispatch_workflow` の 3 op を REST API で追加する。認証は既存の Bearer 方式を踏襲。
2. `knowledge/product/pipeline-templates/` に「CI 失敗の調査」テンプレート(runs 取得 → 失敗 run の特定 → reasoning で次アクション提案)を 1 本追加する。
3. preset 検証: `check:catalogs` / endpoint スキーマ検証を通す。dispatch はモックサーバでテスト。

### Task 3: CHANGELOG 生成 — `claude-sonnet-4`

1. `scripts/extract_changelog_section.ts` が既存なので中身を確認し、「git log 範囲 → Conventional Commits 分類 → CHANGELOG.md セクション生成」の op として code-actuator(または scripts)に整備する。コミット規約は `check:commit-subject` の既存規約を流用する。
2. release フローのテンプレートに組み込み、`docs/developer/RELEASE_OPERATIONS.md` に 3 行で使い方を追記する。

### Task 4: 未対応 IaC 要求の案内 — `claude-haiku`

- `system:terraform` 等の未知 op エラーに、AC-01 の分類エラー形式で「対応 op 一覧と代替(modeling の terraform 読取 / shell adapter)」を含める(エラーメッセージ改善のみ。terraform apply は実装**しない**)。

## リスクと注意

- **デプロイは破壊的操作の最上位**。Task 1 の承認ゲートは省略不可。また adapter が実行するコマンドは設定ファイル由来なので、設定ファイル自体の書き込みが tier-guard の保護下にあること(personal tier)を確認する。
- GitHub Actions op は権限スコープの広い PAT を誘発しやすい。preset の doc に必要最小スコープ(`actions:read` / dispatch には `actions:write`)を明記する。
- ロードマップ非目標(SaaS/公開API)には抵触しない(自リポジトリ/自プロジェクトの CD 補助のみ)。
