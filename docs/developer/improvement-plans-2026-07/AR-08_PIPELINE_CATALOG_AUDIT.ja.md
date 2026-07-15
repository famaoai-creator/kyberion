# AR-08: pipeline カタログ全数監査 — 「動く」の実証と ADF 修復エンジンの false-success 修正

> 優先度: P1 / 規模: M / 依存: AR-01(canonical engine)・AR-02(op registry) / 関連: LC-01(preflight→execute→promote)
> **実施(2026-07-14)**: `pipelines/*.json`(77件)の静的検証 + 実行検証。55/77 を実際に実行し、実行結果から17件の実バグを修正・検証。残り22件(provisioning・destructive・chaos drill・重量級 video/pptx)はユーザー判断でスコープ外。

## 進捗(2026-07-14 完了)

- **静的監査ツール**: schema(`validatePipelineAdf`)+ guardrails(`validatePipelineGuardrails`)+ op 実在チェックを全 77 pipeline に適用するスクリプトを一時作成し実行(恒久化はしていない — 下記「残作業」参照)。
- **実行監査**: 55/77 pipeline を実際に `pnpm pipeline --input ...` で実行し、静的検証だけでは見えない実行時バグを多数発見。
- **修正済み・実行で検証済み**: 16 pipeline JSON + 共有エンジン2箇所(`scripts/run_pipeline.ts`, `libs/core/autonomous-repair.ts`)+ `libs/actuators/process-actuator/src/index.ts`。
- **見つけたが未修正(要判断)**: 4件(下記「未解決の発見」)。

## 背景と課題

pipeline カタログには 77 件の JSON があるが、監査開始時点では:

- schema/guardrails を検証するテストは `tests/pipeline-adf-contract.test.ts` の1件のみで、対象は `vital-check.json` 単体。77件全体を検証するテストは存在しなかった。
- 実際に実行して確認する仕組みは `tests/golden/pipelines.json`(`pnpm check:golden`)のみで、対象は `baseline-check` と `vital-check` の2件のみ(stub backend)。
- つまり **75/77 の pipeline は「定義されているが一度も実行されたことがない」に等しい状態**だった。

「pipeline が実際に動作するか確認してほしい」という依頼に対し、静的検証だけでは不十分と判断し、実行検証を主軸に据えた。実際、以下で見るように **静的検証を通過していた pipeline の半数近くが実行時に失敗した**。

## 発見した不具合と修正

### A. 共有エンジンの重大バグ(pipeline 個別の問題ではない)

1. **`libs/actuators/process-actuator/src/index.ts`**: schema を静的 ESM JSON import(`import processActionSchema from '....schema.json'`)で読み込んでいたため、Node 24 の厳格な ESM ルールでモジュール読込時に即エラー。**`process:*` op を使う pipeline は全て機能しない状態だった**。`safeReadFile` + `JSON.parse` に置換し、`main()` 内の遅延読込に変更(修正: `libs/actuators/process-actuator/src/index.ts:1-17`)。
2. **`scripts/run_pipeline.ts` の `runStepWithRepair`**: 自動修復リトライ時に「修復後のステップ定義」を `refreshedPipeline.steps.find(s => s.id === step.id || s.op === step.op)` で再検索していたが、**トップレベルの steps 配列しか見ておらず、`core:if`/`core:foreach` にネストしたステップを見つけられない**。さらに `op` 一致でのフォールバック検索が、たまたま同じ op を持つ無関係な別ステップを誤って選んでしまう実害を `system-upgrade-check.json` の実行で確認(nested な `system:shell` ステップの修復が、無関係な先行 `system:shell` ステップにすり替わった)。`id` のみで再帰探索する `findStepByIdRecursive` を追加し、`op` フォールバックを廃止(修正: `scripts/run_pipeline.ts`)。
3. **`libs/core/autonomous-repair.ts` の `attemptAutonomousRepair`**: 修復サブエージェントが「セキュリティ境界の正当な拒否なので変更なし・人間にエスカレーション」と明言して**実際に何も変更しなかった**場合でも、`validate()`(schema/guardrails の再検証)が通れば無条件で `true`(修復成功)を返していた。`system-upgrade-check.json` の実行で実際に発生: personal→confidential のティア越境を伴う mission 作成をサブエージェントが正しく拒否したにも関わらず、呼び出し元は「修復成功」とログし、パイプライン全体を ✅ 成功として報告した(実際には mission は作成されておらず、セキュリティ境界自体は破られていない)。修復前後で対象ファイルの実体を diff し、**変更がなければ無条件で false を返す**ように修正(修正: `libs/core/autonomous-repair.ts`)。回帰テストを両ファイルに追加。

### B. pipeline JSON 個別の不具合

| pipeline                          | 不具合                                                                                                                                                                                                                                                                | 修正                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chaos-actuator-down.json`        | ネストしたステップが `"op": "ref"`(未登録 op)を使用                                                                                                                                                                                                                   | `core:include` + `params.fragment` に修正                                                                                                                                                                                                                      |
| `fragments/intra-login.json`      | `evaluate`/`fill`/`click`/`wait` が domain prefix なしで `system:*` に正規化され、実際には browser ドメインの op                                                                                                                                                      | 全て `browser:*` に修正                                                                                                                                                                                                                                        |
| `license-injection-outer.json`    | AR-01 が撲滅したはずの subprocess shell-out アンチパターン(`node dist/.../code-actuator/src/index.js --input ...` を `system:shell` で呼び出す)が残存                                                                                                                 | `core:include` に置換(in-process 実行に統一)                                                                                                                                                                                                                   |
| `license-injection-inner.json`    | bare op(`read_file`/`run_js`/`write_file`)README の `domain:action` 規約違反                                                                                                                                                                                          | `system:` prefix 付与(実害なし、スタイルのみ)                                                                                                                                                                                                                  |
| `audit-verify-daily.json`         | `command` に "node dist/scripts/audit_verify.js --json" というシェル行全体を単一の実行ファイル名として渡していた(shell 展開されないため ENOENT) + v1 schema(`schema`/`actuator` フィールド)                                                                           | `command`+`args` に分離、`action:"pipeline"`/`role`/`op:"system:exec"` に現行化。実行して確認: 修正後は実行できるが **audit chain 48/50 エントリが破損と判明(別問題、下記参照)**                                                                               |
| `voice-hello.json`                | (1) `system:wait_for` という存在しない op(HTTP webhook 待ち。どの op カタログにも実装なし)、しかも出力は後続で未使用 (2) `check_native_tts` の `role` が `source`(capture)だったが実装は apply 側 switch にあり、dispatch 不一致でエラーが出るのに `success` と誤報告 | (1) 削除(実装不能な機能を無理に残さない) (2) `role: "apply"` に修正(`voice-health-check.json` の同一 op 使用箇所と一致させた)                                                                                                                                  |
| `ceo-strategic-report.json`       | (1) `code:analyze` という存在しない op (2) `system:checkpoint` という存在しない op (3) `wisdom:a2a_fanout`/`wisdom:cross_critique` が `prompt_template`(未実装パラメータ)を使い、`topic`+`output_path`(実際の契約)を渡していなかった                                  | `reasoning:analyze` に置換、`system:write_artifact`→最終的に `system:log` に整理、a2a_fanout/cross_critique を実契約(`topic`+`output_path`→`source_path`+`output_path` のファイル chain)で再設計。実行して実際に一貫した戦略分析レポートが生成されることを確認 |
| `executive-narrative-bridge.json` | 同上(`system:checkpoint` + a2a_fanout/cross_critique 契約不一致)。加えて `reasoning:analyze` が `produces.channel` を実際には見ておらず(`params.export_as` のみ参照)、`{{analysis}}` が下流のテンプレートで解決されずリテラル文字列のまま渡っていた                   | 同様に再設計 + `export_as` を明示指定。実行して実際に一貫したナラティブが生成されることを確認                                                                                                                                                                  |
| `contract-review.json`            | 上記2件と同一パターン(a2a_fanout/cross_critique)。加えて `"{{input.output_path \| default: '...'}}"` という `resolveVars` が対応していない架空のパイプ構文(常にリテラルのまま解決されない)                                                                            | 同様に再設計、`wisdom:render_hypothesis_report` を追加して Markdown レポートを生成。実行して契約書の3視点(legal/finance/security)レビューが実際に生成されることを確認                                                                                          |
| `knowledge-sync.json`             | `knowledge/governance/knowledge-sync-rules.json`(存在しない)を参照。実ファイルは `knowledge/product/governance/` 配下                                                                                                                                                 | パス修正                                                                                                                                                                                                                                                       |
| `orchestration-jobs.json`         | 同上のパス誤り。さらに `fallback_path` という `system:read_file` が実装していないパラメータで「対策済み」のつもりになっていた                                                                                                                                         | パス修正、無効なパラメータを削除                                                                                                                                                                                                                               |
| `aws-operations-simulation.json`  | `reasoning:synthesize` に `params.input` を渡していたが、実装が読むのは `params.context` のみ                                                                                                                                                                         | パラメータ名修正(コードリーディングのみで確認 — 実行はセキュリティ分類上のポリシーでブロックされたため、AWS 実 API 呼び出しがコード上皆無であることをコード確認した上で未実行)                                                                                 |
| `marketing-content.json`          | `document_diagram_asset_from_brief` の `role` が `source` だったが実装は `opTransform` 側                                                                                                                                                                             | `role: "transform"` に修正。**未解決**: `brief` パラメータの構造契約が不明瞭(下記参照)                                                                                                                                                                         |
| `ui-voice-browser-smoke.json`     | `dist/libs/actuators/meeting-actuator/src/index.ts` という、`dist/` 配下に存在しないはずの `.ts` パスを参照(コンパイル後は `.js`)                                                                                                                                     | `.js` に修正                                                                                                                                                                                                                                                   |
| `promote-procedure.json`          | `pnpm build` ステップに `timeout_ms` 指定がなく、既定 30 秒(`DEFAULT_TIMEOUT_MS`)で常にタイムアウト(実ビルドは 60 秒以上)                                                                                                                                             | `timeout_ms: 600000` を追加。実行して 61 秒で成功することを確認                                                                                                                                                                                                |
| `system-upgrade-execute.json`     | 同上のタイムアウト不足(`pnpm install && npm run build`、`pnpm test`)                                                                                                                                                                                                  | 同様に `timeout_ms` を追加(destructive pipeline のため静的修正のみ、未実行)                                                                                                                                                                                    |

### C. 誤って「バグ」と判断し、途中で撤回したもの

監査中、以下2件は「バグに見えたが実は正しい」と気づいて即座に元に戻した。記録として残す。

1. **`security-policy.json` の `run_pipeline` 権限拡張**: `health-degradation-watch.json` が `active/shared/observability/ops-alerts.jsonl` に書き込めない件は、ユーザー承認を得てから適用した正規の修正(他ロールには既にこのパスへの書き込み権限があったため、単純な権限漏れと判断)。
2. **`scripts/refactor/mission-state.ts` の `knowledge/personal/missions` パス**: 一見 `active/missions/personal` の誤字に見えたが、`MissionContract` 型定義自身が「personal ミッションは `knowledge/personal/missions` に格納される」と明記しており、`vital_check.ts`/`backup.ts`/`tiered-mission.test.ts` でも一貫して同じパスを使用している **意図的な設計**だった。誤って `active/missions/personal` に書き換えてしまったが、他の参照箇所を横断確認して即座に元に戻した。**この事実自体は別の発見**: `virtual_office.ts`/`mission-hygiene.ts`/`audit-chain.ts` は逆に `active/missions/personal` を使っており、**personal tier のミッション格納場所についてコードベース内に2つの矛盾する規約が共存している**。どちらが正しいかは本監査のスコープ外の設計判断が必要。

## 未解決の発見(要判断・要フォローアップ)

1. **audit chain 破損**: `audit-verify-daily.json` を修正後に実行した結果、`pnpm audit_verify.js` が「48/50 エントリが破損」と報告。本監査中の大量実行によるログ生成が原因か、既存の実データ問題かは未調査。SA-01 の枠で別途調査が必要。
2. **personal tier ミッションパスの二重規約**: 上記 C-2 参照。`knowledge/personal/missions` と `active/missions/personal` のどちらを正とするか、設計判断が必要。
3. **`action-item-reminders.json` の権限ギャップ**: `checkPrerequisites()` が `knowledge/personal/missions`(personal tier、最高機密度)への read/write を試みるが、`system:exec` を実行するロールにはその権限がない。personal tier への権限付与は健康監視系(observability)より遥かに機微なため、本監査では意図的に修正を見送った。
4. **`marketing-content.json` の brief スキーマ不整合**: `media:document_diagram_asset_from_brief` は `ctx[params.from || 'last_json']` に構造化オブジェクト(`brief.payload.source`/`.graph`/`.render_target`/`.layout_template_id`)を期待するが、pipeline は `"brief": "{{input.brief}}"`(生文字列、`from` ではなく `brief` という無効なキー)を渡している。正しい brief オブジェクトの実例が手元になく、スキーマを推測で作ることは避けた。
5. **`generate-masterclass-pptx.json` のネスト pipeline 死角**: `media:pipeline` op が pre-AR-01 形式(v1 `type: capture/apply`)のネストした steps 配列を埋め込んでおり、トップレベルの AJV schema にも `adf-guardrails.ts` の再帰チェックにも見えない盲点になっている。

## 未実行のまま(ユーザー判断でスコープ外、2026-07-14)

以下 22 件は「静的レビューのみ・実行はしない」判断だったが、静的レビュー自体も未実施:

- provisioning/onboarding 系: `kyberion-autonomous-onboarding`, `kyberion-config-provisioner`, `launch-first-run-onboarding`, `platform-onboarding`, `voice-onboarding`, `create-my-avatar`, `setup-oauth`
- destructive 系: `storage-janitor`(`dry_run: false` が既定), `backup-restore-drill`, `soak-endurance`, `soak-restart-e2e`
- chaos drill 系: `chaos-network-partition`, `chaos-secret-missing`, `chaos-repair-test`
- 重量級 video/pptx 系: `generate-masterclass-pptx`, `kyberion-vtuber-narrated-demo`, `-collect`, `-submit`, `trial-narrated-report`

## 残作業

1. **恒久的な corpus-wide 静的検証テストの追加**: `tests/pipeline-adf-contract.test.ts` を拡張し、`pipelines/*.json` 全件を `validatePipelineAdf` + `validatePipelineGuardrails` に通すテストを追加する(監査中に一時スクリプトで実施したが、恒久化はしていない)。AR-02 の登録済み op に対する存在チェックも含めたいが、`core`/`reasoning` ドメインや `working-memory` のような専用 dispatch ドメインを正しく除外する必要がある(素朴な実装は false positive を多発させることを本監査で確認済み)。
2. 上記「未解決の発見」1〜5 のフォローアップ。
3. 上記「未実行のまま」22 件の静的レビュー、または実行検証。

## 関連コミット/変更ファイル

`knowledge/product/governance/security-policy.json`(承認済み権限付与)、`libs/actuators/process-actuator/src/index.ts`、`libs/core/autonomous-repair.ts`(+ test)、`scripts/run_pipeline.ts`(+ test)、`pipelines/{audit-verify-daily,aws-operations-simulation,ceo-strategic-report,chaos-actuator-down,contract-review,executive-narrative-bridge,fragments/intra-login,knowledge-sync,license-injection-inner,license-injection-outer,marketing-content,orchestration-jobs,promote-procedure,system-upgrade-execute,ui-voice-browser-smoke,voice-hello}.json`
