---
title: 'Procedure: External Asset Inventory (外部公開資産・外部サービス棚卸し)'
tags: [capability, security, procedure, asset-inventory, exposure, shadow-it, compliance]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-12
kind: capability
scope: global
authority: policy
phase: [execution, review]
role_affinity: [cyber_security, security_engineer, solution_architect, mission_controller, operator]
applies_to:
  [
    system-actuator,
    browser-actuator,
    network-actuator,
    ingest-actuator,
    approval-actuator,
    wisdom-actuator,
  ]
owner: cyber_security
status: active
---

# Procedure: External Asset Inventory (外部公開資産・外部サービス棚卸し)

IPA 緊急点検 (`../../standards/ipa/unauthorized-access-checklist.md` の A-1 / B-1 / C-1) を実行するための棚卸し手順。**網羅性は単一ソースでは証明できない** — 複数の独立した発見ソースを交差させ、最後に事業部門の人的確認で裏付けるのが本手順の基本原理。

## 1. Goal

自組織の「外部に公開しているアプリケーション」「利用している外部サービス」「保有データ」を棚卸し、承認済み台帳（asset registry）として `knowledge/confidential/{tenant}/security/` に確立する。台帳は後続の `exposure-check` / `account-audit` / IPA チェックリスト適用の入力となる。

## 2. Dependencies

- **Actuators**: `system-actuator`（exec, collect_logs, read_json）, `network-actuator`（fetch）, `browser-actuator`（管理コンソール操作、認証付き）, `ingest-actuator`（調達/経費書類の取込）, `wisdom-actuator`（台帳の知識層への登録）, `approval-actuator`
- **認証情報**: secret actuator + `pipeline-runtime-allowlist.json` で宣言されたスコープのみ。読み取り専用権限を原則とし、書き込み権限は台帳登録先と承認フローに限定
- **台帳保存先**: `knowledge/confidential/{tenant}/security/external-assets.jsonl`（tenant scope 内、append-only JSONL。変更は `pnpm security:ledger` セレモニーのみ — `svc:`/`asset:` ごとに version chain。`--dry-run` で差分、`--verify <ids> --as-of <date>` で検証済み昇格、`--retire <service_id>` で論理削除、`--lineage <service_id>` で履歴、`--set owner=… contract_ref=…` でガバナンス訂正 — 台帳の owner/契約/MFA は人間が `--set`/`--verify` で確定する。昇格は全エントリ事前検証 → 全計算 → 一括 append（部分書き込みなし）で、draft にない台帳エントリは `not_observed` 報告のみで自動削除しない）
- **紳士協定**: 棚卸しは customer-facing なガバナンス証跡なので**ミッション実行が必須**（work-scope-policy の dog-food ルール）

## 3. Inventory Lifecycle

### Phase 0: スコープ定義と権限確保（人間ゲート）

棚卸し開始前に承認を取るもの：

1. **対象範囲の合意**: 組織単位、対象とする資産クラス（公開アプリ / 外部サービス / 保有データ / API連携）、対象から外すもの
2. **調査権限**: IdP 管理コンソール、クラウド組織アカウント、DNS レジストラ、調達/経理記録への read-only アクセス。各アクセスは secret actuator 登録の credential で供給
3. **シャドーIT 方針の確認**: 発見した未承認サービスの扱い（即停止 vs 届出猶予）を事前合意 — 発見時の混乱を防ぐ
4. **調査者の明確化**: IPA A-2/B-2 が要求する「誰がいつどのように確認できるか」の記録先をこの時点で確定

**Approval gate**: Phase 1 進行前に `approval:request`（risk_level: medium）で調査範囲・権限セットを人間承認。

### Phase 1: 発見ソースの多角収集

各ソースを並列で走らせ、結果を生のまま `active/shared/tmp/{mission_id}/discovery/` に蓄積する（正規化は Phase 2）。

| #    | 発見ソース                                                                    | 検出できるもの                                                              | 実行手段                                                                                                           |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| S-1  | IdP/SSO アプリカタログ（Okta, Entra ID, Google Workspace 等の連携アプリ一覧） | SSO 統制下の外部サービス — **最も網羅的な一次ソース**                       | 管理コンソールの CSV export、または vendor API を `network:fetch`（browser-actuator 経由の画面取得も可）           |
| S-2  | OAuth consent / 連携アプリ承認履歴                                            | SSO 外で付与された API 連携・委譲権限                                       | IdP の consent grant 一覧（S-1 と同経路）                                                                          |
| S-3  | DNS レジストラ・ドメイン台帳 + Certificate Transparency（crt.sh 等）          | 外部公開ドメイン、サブドメイン、証明書発行済みの公開資産                    | レジストラ管理画面 + `network:fetch` で CT ログ照会                                                                |
| S-4  | クラウド組織アカウント（AWS Organizations, Azure tenancy, GCP org）           | 全アカウント/プロジェクト、その中の外部公開リソース（EIP, LB, 公開 bucket） | cloud CLI/API の read-only 列挙（`system:exec` 経由の governed op）                                                |
| S-5  | 調達・経費・クレジットカード明細・契約一覧                                    | **シャドーIT** — 承認プロセスを通らず契約された SaaS                        | 書類を `pnpm kyberion read` / ingest-actuator で取込、サービス名を抽出                                             |
| S-6  | メール認証レコード（SPF include / DKIM selector / DMARC レポート）            | メール送信を委託している SaaS（漏れやすい分類）                             | `network:fetch` で DNS TXT 照会、DMARC aggregate レポート精読                                                      |
| S-7  | ネットワーク egress / プロキシ / CASB / FW ログの宛先集計                     | 実トラフィックとして利用中のサービス（未登録分の検出）                      | `system:collect_logs` → 宛先ドメインの頻度集計                                                                     |
| S-8  | ソースコード・IaC・CI/CD 設定（deploy 先・外部 API 参照・Terraform）          | 独自構築の公開アプリ、連携先 API、**IaC 管理下のクラウド/SaaS 一式**        | リポジトリ横断の `code`/`modeling` 系検索 + `modeling:terraform_asset_inventory`（下記「IaC からの派生情報」参照） |
| S-9  | パスワードマネージャの vault 一覧（要同意）                                   | SSO/調達の網にかからない個人・部門契約                                      | vault のエントリ一覧 export（人間が実施、結果のみ授受）                                                            |
| S-10 | 事業部門ヒアリング                                                            | 上記いずれにも現れないもの（紙契約、無償サービス、担当者個人登録）          | semantic brief による構造化ヒアリング（onboarding と同型）                                                         |

**原則**: S-1〜S-4 は技術統制下（既知分）、S-5〜S-10 は統制外（シャドー分）の検出が目的。後者を省略すると「既知のものしか棚卸しできない」という最悪の虚偽陽性になる。

#### IaC（Terraform 等）からの派生情報

Terraform コードは単なるインフラ定義ではなく、**外部サービス利用の宣言的カタログ**として読める。`modeling:terraform_asset_inventory`（`pipelines/terraform-asset-inventory.json` で実行、`modeling:terraform_to_topology_ir` のブロック解析を再利用）が `.tf` 群を解析し、下表の分類を attribute 単位の証拠（`signals`）付きで `TerraformAssetInventory` IR として出力する。分類は Checkov/Trivy と同じ属性粒度スタイル — 各判定に対象属性と観測値を保持し、動的参照（`var.`/`local.`/`data.`）は推測せず `unresolved_refs` に記録する。SG ルールの `security_group_id` 参照を同ディレクトリ内で解決し、開放 SG 配下のインスタンス/ELB/DB に `EXPOSURE_VIA_OPEN_SG`（confidence: indirect）を付ける簡易ジョインも含む：

| 抽出元                                                       | 台帳に転記する情報                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` ブロック                                          | **利用外部サービス一覧そのもの** — `aws`/`azurerm`/`google` の他、`cloudflare`, `datadog`, `pagerduty`, `okta`, `auth0`, `github`, `vercel`, `sendgrid` 等の SaaS provider が B-1 のエントリに直結                                                                                                        |
| `resource` タイプ + 属性                                     | 公開資産候補: `aws_lb`(internet-facing), `aws_eip`/public IP, `aws_api_gateway_*`, `aws_cloudfront_distribution`, `aws_db_instance`(`publicly_accessible`), `azurerm_public_ip`, `google_compute_global_address`, セキュリティグループ `0.0.0.0/0` ingress, 公開 bucket ポリシー → `endpoints`/`exposure` |
| `aws_route53_record` / `cloudflare_record` 等の DNS リソース | CNAME（Heroku/Vercel/ELB 等のホスティング先）、TXT（SaaS 検証レコード）、MX（メール事業者）、SPF include（送信委託 SaaS）→ S-3/S-6 の内容がコードとして読める                                                                                                                                             |
| `backend` ブロック / `data.terraform_remote_state`           | state 保管先 = クラウドアカウント/リージョンの手がかり（S-4 接続）、リモート state 参照は別環境との結合点                                                                                                                                                                                                 |
| `output` ブロック                                            | 公開エンドポイント URL（`endpoints`）                                                                                                                                                                                                                                                                     |
| `module` の `source`                                         | registry/git 参照 → IaC 依存関係、追加の調査対象リポジトリ                                                                                                                                                                                                                                                |
| `variable`/`*.tfvars`                                        | 環境・ドメイン名。**値が秘密のものは読まない**（変数名のみ記録、credential は secret actuator 管轄）                                                                                                                                                                                                      |

**限界（他ソースで補完する）**:

- IaC 管理下のものしか見えない — コンソール手作業（click-ops）や別コードベースの資産は S-4/S-7 で補完
- `terraform state` とコードのドリフト（state 側にだけ存在する実リソース）は静的解析では拾えない。ドリフト検出は apply 権限を伴うため別途承認
- `data` ソース参照・動的に解決される値は静的には確定できない
- 複数リポジトリ/複数 state に分散している前提で列挙する（S-8 のリポジトリ列挙と組）

### Phase 2: 台帳への正規化登録

収集した生データを canonical サービス単位に dedup し、台帳スキーマに正規化する。IaC ソース（S-8）については `modeling:asset_inventory_to_ledger`（`pipelines/external-asset-ledger.json` で実行）が `IaCAssetInventory` → 台帳ドラフトへ機械変換する — `svc:` = 外部サービス、`asset:` = 公開アプリ/データストアのエントリを証跡（`provenance`）付きで出力し、owner/contract/MFA/データ分類が未確定のエントリは `review_status: pending` + `shadow` で人間レビューに渡す：

| フィールド             | 説明                                                                                                                                                                          | IPA対応          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `service_id`           | 正規化した一意識別子（slug）                                                                                                                                                  | —                |
| `name` / `vendor`      | サービス名・提供者                                                                                                                                                            | B-1              |
| `category`             | `saas` / `cloud` / `vpn` / `published-app` / `api-integration` / `data-store` / `network-control`（SG/NSG/firewall の公開発見）/ `identity`（IAM ポリシー・ロールの権限発見） | B-1, A-1         |
| `endpoints`            | 公開 URL / ドメイン / IP（公開アプリのみ必須）                                                                                                                                | A-1              |
| `exposure`             | `public` / `partner-restricted` / `internal-only`                                                                                                                             | A-1, PA-1        |
| `data_classification`  | `personal` / `confidential` / `public` + 個人情報有無                                                                                                                         | C-1              |
| `auth_method`          | `sso` / `local-password` / `api-key` / `federated`                                                                                                                            | PA-2, PS-1       |
| `mfa_status`           | `enforced` / `optional` / `unavailable` / `unknown`                                                                                                                           | PA-2, PS-1       |
| `log_access`           | 誰が・どこで・どれくらいの保持期間のログを見られるか                                                                                                                          | A-2, B-2         |
| `account_admin`        | アカウント棚卸の管理者・手続き経路                                                                                                                                            | B-3, PS-3        |
| `owner` / `department` | 責任者・利用部門                                                                                                                                                              | B-1              |
| `contract_ref`         | 契約・調達記録への参照（無償は `none`）                                                                                                                                       | S-5 突合用       |
| `discovery_sources`    | 検出に寄与したソース ID の配列（S-1〜S-10）                                                                                                                                   | 網羅性の証跡     |
| `last_verified`        | 最終検証日                                                                                                                                                                    | 棚卸運用（PS-3） |

**判定ルール**: `owner` 不明、`contract_ref` なし、`discovery_sources` が S-7/S-9 のみ（統制外ソースのみ）のものは `shadow: true` フラグを立てて報告対象にする。

### Phase 3: 検証とリスク分類

1. **到達性・公開性確認**: 台帳の `published-app`/`saas`/`cloud` エンドポイントを `exposure-check` パイプライン（`modeling:security_ledger_check_plan` → `network:exposure_check`）で外部到達性を検証（A-1）。結果 JSON を `pnpm security:ledger --tenant <slug> --record-checks <checks.json>` で台帳エントリの `check_results` に証跡化（per-item try/catch — 到達不能は失敗ではなくチェック結果）
2. **データ分類の付与**: 担当部門ヒアリングまたは接続先の記録から `data_classification` を確定（C-1）— `--set data_classification=…` で台帳に記録
3. **リスク順位付け**: `pnpm security:ledger --report` で `exposure × data_classification` マトリクス + shadow 一覧を出力 — `public` × `personal` が最優先で IPA 点検 A-2/A-3/B-2/B-3 の適用対象

### Phase 4: 点検適用（IPA チェックリスト接続）

台帳の全エントリに対し `unauthorized-access-checklist.md` の項目を適用：

- A-2/B-2: `log_access` 経路で直近ログの異常確認 → 異常検出は即 `security-incident-response` へ
- A-3: 未適用パッチ確認（`published-app` の構成要素）
- B-3: `account_admin` 経路でアカウント棚卸し実行

結果は台帳エントリの `check_results` として `--record-checks` で証跡化（check_id ごとの最新結果、履歴は version chain）。**異常なしで完了しない** — 「全ソース処理済み + 人的確認済み」が完了条件（§4 参照）。

### Phase 5: 報告とギャップ処理

- `security:ledger --report` の `shadow_entries` / `coverage_gaps` / `stale_checks` / `critical_public_sensitive` を経営層/セキュリティ責任者へ報告（Phase 0 の合意方針に従い停止・届出・存続を個別承認）
- `security:ledger --request-approvals` で shadow エントリの disposition を一括の承認リクエスト（terminal channel、`mission_gate`）として起票 — 承認後は `--approval-id <request_id>` を付けて `--retire`（停止）または `--draft --set owner=… contract_ref=…`（ガバナンス供給）を適用。`owner` 不明資産は廃止候補として承認ゲートに送る（停止・解約は常に `approval:request` 経由。自律実行しない）
- 棚卸し結果サマリを `writeScopedArtifact` で台帳と同じ tenant scope に保存

### Phase 6: 定常化

- **定期再実行**: `pipelines/exposure-check.json` に `schedule`（四半期・月初 06:00 JST）— テナント配備は `knowledge/confidential/{tenant}/pipelines/` への配置 + `pnpm kyberion project-trust request <path>` → `pnpm kyberion approve <id> project-trust` の内容承認が前提（pipelines/README.md の tenant-scheduled 規則）。`stale_checks`/`missing` が溜まったチェックは同じ `--record-checks` で再証跡
- **イベント駆動**: IdP の新規アプリ連携、新規 DNS/CT エントリ、新規クラウドアカウント発生を検知して台帳へ自動追加候補を起票（`advisory-watch`/`tenant-drift-watch` と同じ検知→起票パターン）
- **廃止時の逆流**: サービス解約・公開停止時に台帳からの削除も governed 手続き（`--retire` — 監査証跡のため論理削除）

## 4. Expected Output（完了判定）

以下すべてが揃って初めて棚卸し完了とする：

1. `knowledge/confidential/{tenant}/security/` 配下に承認済み台帳が存在し、全エントリが必須フィールドを持つ
2. S-1〜S-10 の適用可能なソース全てについて coverage ledger に「実施済み/適用外理由」が記録されている
3. `shadow: true` エントリ全てに人間の処置承認（または正式な見送り記録）がある
4. `public` × `personal` エントリ全てに IPA A-2/A-3/B-2/B-3 点検の結果証跡がある
5. 責任者による「網羅性の人的確認」の承認レコードがある（Phase 0 の approval と対になる完了承認）

---

_Reference: `../../standards/ipa/unauthorized-access-checklist.md` (点検項目 ID), `security-incident-response.md` (異常発見時の接続先), `../../standards/security/owasp_asvs.md` (深度基準)._
