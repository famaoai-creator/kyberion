---
title: ソースコード由来エンジニアリング成果物
tags: [source-analysis, design-document, test-inventory, iac, pipeline]
last_updated: 2026-08-23
---

# ソースコード由来エンジニアリング成果物

`source-to-engineering-artifacts` は、リポジトリのソースコードと設定を静的に解析し、同じ解析結果から設計書、試験項目、自動試験シナリオ、IaC提案を生成します。

## 実行

```bash
pnpm pipeline --input pipelines/source-to-engineering-artifacts.json \
  --context '{"source_root":".","project_id":"repo-audit","target_provider":"aws","output_dir":"active/shared/tmp/source-engineering"}'
```

出力先は `active/shared/tmp/` または mission の `active/missions/...` に限定されます。

| 成果物                                  | 内容                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `source-analysis-ir.json`               | ファイル、言語、import/export、route、test、IaCの根拠付きIR     |
| `source-derived-design.md`              | 依存/import/export/route/IaC/testを含む設計書ドラフト           |
| `source-test-inventory.json`            | assertion・behavior・副作用シグナル付き試験項目                 |
| `source-test-scenarios.json`            | 承認済みの安全なテストだけを実行するADF pipeline                |
| `iac-proposal.json` / `iac-proposal.tf` | provider指定時のIaC starter/proposal。実環境へのapplyは行わない |

## 安全境界

- 解析は静的ヒューリスティックであり、compiler ASTや実行時call graphを推測しません。
- workspace直下を解析する場合は、`active/`、`knowledge/`、provider state、vault、credentialファイルを自動除外します。対象コードは `source_root` で明示してください。
- 設計書には依存/import/exportの静的シグナルを含めますが、実行時call graphではありません。
- 既存テストは Vitest/Jest/Pytest/go-test の検出に加え、既知のnetwork/process/filesystem mutationがない場合だけ `safe_auto` になります。副作用シグナル付きテストは `approval_required` としてシナリオから延期されます。
- assertion数とbehavior categoryは字句的推定であり、機能カバレッジの証明ではありません。
- routeや外部環境を伴う試験は、認証・fixture・selectorが推測できないため `manual_only` として残ります。
- IaCは target provider が未指定なら生成を停止し、既知providerなら入力変数付きstarterを生成します。いずれも proposal-only です。
- `terraform fmt -check`、`terraform validate`、`terraform plan`、人間レビューを経てから別の適用フローへ渡します。
- IR、test inventory、test scenario、IaC proposalは生成時にversioned schemaで検証されます。

生成された `source-test-scenarios.json` は、内容をレビューした後に次で実行できます。

```bash
pnpm pipeline --input active/shared/tmp/source-engineering/source-test-scenarios.json
```

## Agentic Source Review

Google Threat Intelligence の Agentic Vulnerability Discovery Harness の考え方を、`pipelines/agentic-source-code-review.json` に取り込みました。単発のLLMスキャンではなく、次の段階を固定したハーネスです。

1. deterministic reconnaissance: `source-analysis-ir.json` から言語、依存、route、候補入口を抽出
2. threat model: 資産、trust boundary、除外範囲、前提、ルール選択を `agentic-source-review-plan.json` に出力
3. human gate: `threat_model_approved=true`、`approval_ref`、tenant、mission scope が揃うまで後続を開始しない
4. hypothesis review: 承認後だけ静的スキャン、access-control / data-flow / dependency-supply-chain の多視点仮説、独立批評を実行
5. expert handoff: 重複排除・確信度判定後も、人間が到達可能性と補償制御を確認するまで所見は未確定
6. evidence verification: 批評結果を型付き候補へ正規化し、source_refs、entry point、evidenceの存在を検証する。未知参照・形式不正・重複はfail-closedで `needs_review` / `duplicate` として保持し、脆弱性の確定とは扱わない
7. coverage ledger: 解析上限、snapshot hash、選択済み入口、未カバー入口、trackごとの追跡を `coverage` として出力し、再実行範囲を明示する

既定の外部推論エグレスは拒否です。ローカル推論バックエンドを使う場合だけ `external_egress=deny` のまま実行できます。外部バックエンドを使う場合は、対象テナント・mission・出力tier・脅威モデル承認に加えて `external_egress_approved=true` を明示しない限りゲートで停止します。ソースレビューの出力tierに `public` は指定できません。コメント、ドキュメント、依存メタデータは間接プロンプトインジェクションの可能性があるため、常にデータとして扱います。検証レポートは `agentic-source-review-verification.json` に出力され、承認済みfindingは後続で `source-test-scenarios` へ回帰テスト昇格する契約を持ちますが、承認前に対象コード、PoC、exploit、修正、自動コマンドは実行しません。PoC実行、自動修正、IaC apply はこのパイプラインから行いません。

```bash
pnpm pipeline --input pipelines/agentic-source-code-review.json \
  --context '{"source_root":"libs/core","target_dir":"libs/core","project_id":"kyberion-core","tenant_slug":"<tenant>","mission_id":"<mission>","output_dir":"active/missions/confidential/<mission>/evidence/agentic-source-review"}'
```
