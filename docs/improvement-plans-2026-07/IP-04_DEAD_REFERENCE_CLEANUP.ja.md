# IP-04: 死んだ参照の一掃と参照整合性チェックの自動化

> 優先度: P1 / 規模: S / 依存: なし

## 背景と課題

package.json・パイプライン定義・スキーマの間で参照切れが多数あり、該当コマンドは実行時に必ず失敗する。また参照整合性を守る仕組みが無いため再発する。

### A. ソースが存在しない npm scripts(実行すると module not found)

`mission:create`(`dist/scripts/create_mission.js`)、`init`/`init-wizard`(`init_wizard.js`)、`benchmark`、`plugin`(`plugin-manager.js`)、`issue:ingest`(`ingest_issue.js`)、`janitor:scan`/`janitor:run`(`run_janitor.js`)、`audit:export`/`audit:verify`(`export_audit.js`)、`catalog`(`generate_docs.js`)、`vault:mount`(`vault_mount.js`)、`archive`(`archive_missions.js`)、`nerve:pulse`(`pulse_aggregator.js`)— いずれも対応する `.ts` ソースがリポジトリに存在しない(package.json:107,124,174-199 付近)。

### B. 存在しないパイプラインを指す npm scripts

- `analysis:job` → `pipelines/analysis-job.json`(package.json:49)— 実体は `knowledge/product/pipeline-templates/` にのみ存在
- `judgment:job` → `pipelines/judgment-job.json`(:50)— 同上
- `voice:clone` → `pipelines/clone-my-voice.json`(:153)、`voice:speak` → `pipelines/speak-with-my-voice.json`(:154)— 同上

### C. 存在しないスクリプトを参照するパイプライン

- `pipelines/fragments/executive-report-gen.json:19` → `dist/scripts/report_generator.js`(ソース無し)
- `pipelines/fragments/comfyui-artifact-ingestion.json:26` → `dist/scripts/ingest_external_artifacts.js`(ソース無し)
- `pipelines/meeting-proxy-workflow.json:48` → `libs/actuators/meeting-browser-driver/scripts/playwright-meet-join.mjs`(ファイル無し。meeting-proxy ワークフローは壊れている)

### D. 孤児レガシーパイプライン

`pipelines/core-base-stabilizer.yml`、`module-path-fixer-logic.yml`、`system-init-logic.yml` は参照ゼロ。`high-fidelity-logic.yml` は同名テンプレートと名前一致のみ。

### E. スキーマの二重定義

ランタイム検証は `knowledge/product/schemas/pipeline-adf.schema.json`(`libs/core/pipeline-contract.ts:95`)を使うが、リポジトリ直下 `schemas/` に別系統のパイプラインスキーマ(`file-pipeline.schema.json` ほか6本が参照ゼロ、2本がテスト参照のみ)が残っており、ドリフトし得る。

### F. ガバナンスチェックの走査漏れ

`scripts/check_pipeline_shell_independence.ts` の `PIPELINE_ROOTS` は `pipelines/` と `pipelines/fragments/` のみで、ユーザー向けの `knowledge/product/pipeline-templates/`(99ファイル)を走査していない。

## ゴール(受入条件)

1. A〜D の死んだ参照がゼロになる(削除 or 修復。判断基準は下記)。
2. 「package.json の全 script が指す実体の存在」を検証するチェックが `pnpm validate` チェーンに入り、CI で再発を防ぐ。
3. `check:pipeline-shell-independence` が pipeline-templates も走査する。
4. `schemas/` 直下の孤児パイプラインスキーマの扱い(削除 or 正本への統合)が決まり、実施される。

## 実装タスク

### Task 1: 死活判定と処置(A・B・D)— `claude-sonnet-4`

1. A の各エントリについて `grep -rn "<script名>" docs/ knowledge/ pipelines/ scripts/ libs/ --include='*.md' --include='*.json' --include='*.ts'` で参照を確認する。
   - **参照ゼロ** → package.json からエントリ削除。
   - **ドキュメントから参照あり** → エントリは削除した上で、参照しているドキュメントの該当記述を更新(削除理由を一行残す)。復活が必要そうな機能(例: janitor は `libs/core/storage-janitor.ts` が現存)は、削除の代わりに正しい実装への付け替えを検討し、判断を PR 説明に記載する。
2. B の 4 エントリは、テンプレートを `pipelines/` へ昇格させるのではなく、`--input knowledge/product/pipeline-templates/<name>.json` へパスを修正する(テンプレートが実行可能形式であることを `pnpm pipeline --input ...` のドライ実行で確認)。実行不能なら script エントリごと削除して報告。
3. D の 3 つの未参照 `.yml` は `retired/pipelines/` へ移動(ディレクトリが無ければ作成し README を1行置く)。`high-fidelity-logic.yml` は同名 JSON テンプレートとの内容差分を確認し、重複なら同様に retire。

### Task 2: 壊れたパイプライン参照の修復(C)— `claude-sonnet-4`

1. `meeting-proxy-workflow.json:48` — `libs/actuators/meeting-browser-driver/` 配下を調査し、`playwright-meet-join.mjs` に相当する現行実装(ビルド済み dist パスや別名スクリプト)を特定して参照を修正する。相当物が無ければワークフロー自体を retire し、`pipelines/README.md` から除去する。
2. fragments 2 件は参照元(このフラグメントを include するパイプライン)を grep で特定し、上流ごと死んでいるなら retire、生きているならスクリプト名の修正 or フラグメント削除を行う。

### Task 3: 参照整合性チェックスクリプトの新設 — `claude-sonnet-4`

1. `scripts/check_script_integrity.ts` を新設する。検証内容:
   - package.json の全 `scripts` エントリから `dist/scripts/X.js` / `scripts/X.ts` / `pipelines/*.json` へのパス参照を抽出し、`dist/scripts/X.js` は対応する `scripts/X.ts` ソースの存在を、それ以外は実ファイルの存在を確認する。
   - `pipelines/**/*.json` と `pipelines/fragments/**/*.json` 内の `cmd` に現れる `dist/scripts/*.js`・`scripts/*.ts`・リポジトリ内 `.mjs` パスの実在を確認する。
2. 既存の `check_*` スクリプト(例: `scripts/check_catalog_integrity.ts`)の構造・出力形式・exit code 規約に合わせる。unit test(`scripts/check_script_integrity.test.ts`)を付け、意図的に壊した fixture で fail することを検証する。
3. package.json に `check:script-integrity` を追加し、`validate` チェーンに組み込む。

### Task 4: 走査漏れとスキーマ二重定義の解消(E・F)— `claude-sonnet-4`

1. `check_pipeline_shell_independence.ts` の `PIPELINE_ROOTS` に `knowledge/product/pipeline-templates/` を追加し、実行して新規違反を棚卸しする。違反があれば同スクリプトの既存メッセージ規約に従って修正(テンプレート側の `$(pwd)`・`/tmp` 等を除去)する。
2. `schemas/` 直下の `*-pipeline.schema.json` 8 本について参照を再確認し、参照ゼロの 6 本は削除、テスト参照のみの 2 本(`system-pipeline`, `browser-pipeline`)はテストを正本 `knowledge/product/schemas/pipeline-adf.schema.json` ベースに書き換えた上で削除する。削除一覧を PR 説明に記載する。

### Task 5: 検証 — `claude-haiku`

- `pnpm validate` が新チェック込みで通ること、`pnpm pipeline --input pipelines/baseline-check.json` が従来どおり動くこと、修正した B の 4 コマンドが起動することを確認し、結果を報告する。

## 実装メモ

- `libs/actuators/meeting-actuator/meeting-bridge.py` が参照していた欠落ファイルを補うため、`libs/actuators/meeting-browser-driver/scripts/playwright-meet-join.mjs` を復元した。`meeting-bridge.py` の join 経路は再び起動可能になった。

## リスクと注意

- 「ソースが無い」ものの中に、**gitignore された古い dist 成果物で偶然動いているもの**がある(`run_janitor.js`, `export_audit.js`)。削除時は「古い dist で動いていた挙動に依存する運用が無いか」を docs/knowledge の grep で確認する。
- confidential tier(`knowledge/confidential/`)配下は本 IP の走査対象に含めない(AGENTS.md R5)。

## 実装状況 追記 (2026-07-12)

**Task 4.2(スキーマ二重定義)を再監査のうえ完了 — IP-04 は DONE。**

- 2026-07-03 監査の「6本参照ゼロ」は陳腐化: `schemas/*-pipeline.schema.json` の大半は現在、各アクチュエータ manifest の `contract_schema` と `scripts/contract-baseline.json` から参照される**正規の契約スキーマ**であり(check:contract-schemas / check:contract-semver の対象)、削除対象ではない。
- 真に参照ゼロだった `ingestion-pipeline.schema.json` / `super-nerve-pipeline.schema.json` の2本を削除(contract-baseline 非掲載を確認、契約チェック緑)。
- `browser-pipeline.schema.json` の schemas/ 版と knowledge/product/schemas/ 版は**同名だが別契約**(前者=アクチュエータ契約、後者=browser-extension-bridge の draft スキーマ)であり二重定義ではない — 混同しやすい命名として記録に留める。
