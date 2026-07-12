# QA-01: ソフトウェア品質ライフサイクル — DoR・AC・DoDから品質報告までを証跡でつなぐ

> 優先度: **P0** / 規模: L(段階導入) / 依存: MO-02, IL-01 / 関連: IP-03, IP-07, HO-01, SA-03, SU-03
> 状態: **DONE(2026-07-12 実装・検証完了)**

> **実装状況(2026-07-12): DONE** — 5成果物schema、10観点の正準カタログ、DoR/AC/DoD・traceability評価、mission gate、`wisdom:derive_test_inventory`、actuator別ADF compiler/dispatch、安全分類、欠陥状態機械、品質報告、operator home、`software-qa-lifecycle` fragment、6シナリオE2E、`report-only → warn → enforce`を実装。

## 1. 背景と現状

Kyberion には、要件・設計から `test-plan.json` を生成する `wisdom:extract_test_plan`、must-have 要件がテストケースに紐づくかを調べる `QA_READY`、タスク受入ゲート、tester ロールがある。これらは有用だが、現状の QA は「テスト計画が存在し、要求 ID が一度は参照されている」ことの確認に留まる。

- `TestCase` は手順、期待結果、優先度、6 種のテスト種別、要求参照を持つが、事前条件、テストデータ、実行環境、リスク、品質特性、自動化可否、担当、結果証跡を表現できない。
- `QA_READY` は must-have 要件の参照有無だけを見る。DoR、AC の検証可能性、観点の網羅性、重複・矛盾、非機能要求、変更影響は判定しない。
- 標準 SDLC pipeline はテスト計画の生成までで、テスト項目のレビュー、実行、欠陥記録、再試験、品質報告、リリース判定へ接続されていない。
- DoR、AC、DoD がリポジトリ全体で共通契約になっておらず、計画文書の受入条件、タスクの `test_criteria`、mission gate が別々の語彙で運用される。
- tester ロールは責務を宣言しているが、実行可能な作業契約と成果物スキーマがない。AI が試験を実行しても、誰がリスクを受容しリリース責任を持つかを記録する欄がない。

IP-03 は CI の実行範囲、IP-07 は Kyberion 自身のクリティカルパステスト、MO-02 は汎用ゲートを扱う。本計画はそれらを置き換えず、**任意のソフトウェア開発ミッションで QA を設計・実行・報告する標準業務フロー**を追加する。

## 2. 正準定義

### DoR (Definition of Ready)

実装または試験作業を**開始してよい状態**の入口条件。少なくとも、目的・対象範囲・優先度・依存関係・既知リスク・責任者・検証可能な AC・必要な環境/データが明確で、重大な未決事項がないことを意味する。DoR は成果物の完成条件ではない。

### AC (Acceptance Criteria)

個々の要求、ストーリー、変更を**受け入れられるか判定する、観測可能で二値判定可能な条件**。正常系だけでなく、拒否・失敗・権限・境界条件を含め、要求 ID とテスト項目へ追跡可能にする。実装方法の指定ではなく外部から観測できる結果を主とする。

### DoD (Definition of Done)

変更を**完了として扱うための出口条件**。全 AC 合格に加え、必要なレビュー、回帰試験、セキュリティ/性能等の品質ゲート、文書・運用手順、監視、証跡、未解決欠陥と残存リスクの扱いが完了していることを意味する。例外は、理由・期限・リスク所有者・人間の承認を持つ waiver として記録する。

DoR、AC、DoD は次の関係で運用する。

```text
DoR 合格 → 実装/試験設計 → AC をテスト項目で検証 → DoD 合格 → 人間がリリース判断
```

## 3. ゴールと受入条件

1. ソフトウェア開発ミッションが、正準な DoR・AC・DoD と例外承認を構造化データで保持し、開始・受入・完了ゲートで機械判定される。
2. 要求、リスク、設計、変更差分、運用条件から試験観点を抽出し、観点 → テスト条件 → テストケース → 実行結果 → 欠陥 → 品質判定のトレーサビリティを保持する。
3. 機能適合性だけでなく、セキュリティ、性能、信頼性、可用性、保守性、互換性、アクセシビリティ、国際化、プライバシー、可観測性、バックアップ/復旧を対象にできる。
4. unit / component / contract / integration / e2e / acceptance / exploratory / static analysis の試験レベルを、重複を避けながらリスクに応じて割り当てられる。
5. Kyberion が安全に自動実行できる項目は actuator/pipeline で実行し、外部環境・実データ・破壊的操作・本番負荷を伴う項目は承認または人手実施へ分離する。
6. 実行結果はコマンド、環境、対象版、時刻、実行主体、ログ/スクリーンショット等の証跡、再現手順を持ち、再試験と回帰試験へ引き継げる。
7. 品質報告が、要求/リスク被覆、実行進捗、合否、欠陥傾向、未実施項目、残存リスク、waiver、リリース推奨を根拠付きで提示する。AI は推奨できるが、最終承認者とリスク受容者は人間として記録される。
8. fixture を使った決定論的 E2E で、`intake → DoR → 観点抽出 → 項目化 → 実行 → 欠陥/再試験 → 品質報告 → DoD` が再現できる。

## 4. 標準の試験観点カタログ

「網羅的」は全組合せの総当たりではなく、要求・リスク・変更影響に対して必要な観点が選択され、除外理由まで説明できる状態と定義する。正準カタログには最低限、次を含める。

| 軸           | 主な観点                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- |
| 要求・業務   | 正常、代替、異常、業務ルール、権限、監査、取消/再実行、AC 対応                                      |
| 入力・データ | 同値分割、境界値、null/空、形式、最大長、文字コード、重複、順序、日時/タイムゾーン、個人/機密データ |
| 状態・制御   | 初期状態、遷移、冪等性、並行/競合、タイムアウト、リトライ、中断/再開、ロールバック                  |
| 接続・契約   | API/schema、後方互換、認証/認可、部分障害、レート制限、外部サービス劣化、契約変更                   |
| 品質特性     | 性能、容量、負荷、耐久、信頼性、可用性、復旧性、保守性、移植性、互換性                              |
| セキュリティ | 入力検証、権限昇格、秘密情報、注入、egress、依存脆弱性、監査完全性、fail-closed                     |
| UX           | アクセシビリティ、キーボード、表示言語、エラー回復、進捗、レスポンシブ、ブラウザ/端末差             |
| 運用         | ログ、メトリクス、アラート、構成、デプロイ、migration、rollback、backup/restore、runbook            |
| 変更影響     | 差分、依存先/依存元、回帰範囲、既知欠陥、過去障害、feature flag、段階リリース                       |
| AI/agent     | 非決定性、モデル/プロンプト差、幻覚、prompt injection、ツール権限、承認境界、再現性、human handoff  |

観点抽出器は、各観点に `source_refs`、`risk_level`、`applicable`、`rationale`、`omission_reason` を必須化する。モデルが生成しただけの観点は確定せず、決定論的ルールとの和集合、重複排除、独立レビューを経て test inventory に昇格させる。

## 5. 実装タスク

### Task 1: QA 契約と語彙の正準化 — `claude-sonnet-4`

1. `knowledge/product/schemas/` に以下を追加する。
   - `software-quality-contract.schema.json`: DoR、AC、DoD、品質目標、責任者、waiver。
   - `test-inventory.schema.json`: 観点、テスト条件、ケース、要求/リスク/設計参照、優先度、自動化方式。
   - `test-execution-record.schema.json`: suite/run/case 結果、版、環境、主体、証跡、再試験関連。
   - `defect-record.schema.json`: 重大度、優先度、再現手順、影響、原因、修正版、状態遷移。
   - `software-quality-report.schema.json`: 被覆、結果、欠陥、残存リスク、waiver、推奨、human sign-off。
2. AC は一意 ID、要求参照、観測可能な期待結果を必須とし、曖昧語だけの条件を validator で警告する。DoR/DoD check は `check_id`、判定方法、証跡要求、owner を持つ。
3. 既存 `TestPlan` は一括破壊せず、v1 読み込み互換を保つ adapter を用意し、新規生成を v2 inventory に寄せる。

### Task 2: DoR・AC・DoD ゲート — `claude-sonnet-4`

1. MO-02 の `mission-gate-engine` に `quality_contract_valid`、`dor_satisfied`、`acceptance_criteria_verified`、`dod_satisfied` を追加する。
2. DoR 不合格は dispatch せず Alignment に戻し、不足情報を質問/next action として提示する。AC 不合格は rework、DoD 不合格は `validating` に留める。
3. waiver は human identity、理由、対象 check、期限、補償統制、残存リスクを必須とし、AI 自身による自己承認を禁止する。
4. contract と gate の unit test、v1 artifact 互換テスト、waiver の期限切れ/権限テストを追加する。

### Task 3: 試験観点抽出と項目設計 — `claude-sonnet-4`

1. 正準観点カタログを `knowledge/product/governance/software-test-viewpoints.json` と schema に持たせ、対象システム特性・mission risk・変更差分から適用候補を決定論的に選ぶ。
2. reasoning backend に「候補観点の補完・反証」を行わせ、決定論的候補を削除させず、追加理由と確信度を記録する。高リスクでは実装者と別コンテキストの tester/reviewer が抜けをレビューする。
3. 観点から、テスト条件、具体ケース、必要データ/環境、期待結果、実施レベル、自動化方式、優先度を生成する。pairwise/state-transition/property-based/fuzz 等は適用理由がある場合のみ選ぶ。
4. traceability validator を追加し、must-have 要求、全 AC、高リスク、重大品質特性に未割当があれば `QA_READY` を fail にする。件数だけの coverage を品質の代理にしない。

### Task 4: 安全な試験実行オーケストレーション — `claude-sonnet-4`

1. `pipelines/fragments/software-qa-lifecycle.json` を追加し、`validate_contract → evaluate_dor → derive_viewpoints → build_inventory → review_inventory → execute_safe_tests → ingest_results → evaluate_ac/dod → render_report` を typed flow として構成する。
2. 実行アダプタは既存 actuator を再利用する。code/system は unit・lint・build・static check、browser は UI/E2E、network は契約/疎通、security 系 checker は依存/秘密/egress、operator/manual は人手結果の取り込みに割り当てる。
3. 各ケースを `safe_auto`、`approval_required`、`manual_only`、`prohibited` に分類する。本番書込、実顧客データ、負荷/侵入、外部通知、課金、破壊操作は既定で自動実行しない。
4. shard/再試行/timeout/quarantine をサポートするが、同一失敗を無変更で再試行しない。flake は失敗を合格へ書き換えず、独立した不安定性指標として報告する。

### Task 5: 欠陥・再試験・回帰管理 — `claude-sonnet-4`

1. failed/error/block の結果から defect candidate を生成し、同一 fingerprint を重複排除する。AI が欠陥を推定した場合は `candidate` とし、人間または再現試験で確定する。
2. severity(影響)と priority(修正順)を分離し、修正コミット/成果物、原因、影響範囲、再試験ケース、回帰 suite を関連付ける。
3. 修正差分と依存グラフから回帰候補を選び、全件回帰を省く場合は選定根拠と未実施リスクを記録する。
4. reopen、duplicate、cannot_reproduce、accepted_risk を含む状態遷移と監査ログをテストする。

### Task 6: 品質報告とリリース責任 — `claude-sonnet-4`

1. `software-quality-report` generator を追加し、少なくとも以下を出す: 対象版/環境、DoR/AC/DoD 状態、要求・リスク・観点被覆、計画/実施/合否/未実施、重大度別欠陥、flake、品質特性別評価、waiver、残存リスク、前回差分、証跡リンク。
2. リリース推奨は `go / conditional_go / no_go / insufficient_evidence` とし、閾値だけでなく判定理由を出す。証跡不足を pass と扱わない。
3. AI/tester は推奨と根拠を作成し、`accountable_human_id` が最終判断とリスク受容を署名する。判断変更も履歴として残す。
4. operator surface/SU-03 には要約、ブロッカー、残存リスク、承認操作を表示し、詳細証跡へ drill-down できるようにする。

### Task 7: 決定論的 E2E と段階導入 — `claude-sonnet-4`

1. fixture プロジェクトで正常系、DoR 不足、AC 未被覆、試験失敗→修正→再試験、重大欠陥残存、期限付き waiver の6シナリオを実行する。
2. 導入は `report-only → warn → enforce` とし、まず既存ミッションで欠落率・誤検知・実行時間を計測する。P0/高リスク mission から enforce し、低リスクは軽量プロファイルを維持する。
3. 既存 `standard-sdlc-loop` には v2 QA artifact 生成を追加するが、実行は別 fragment として再利用可能に保つ。
4. `CAPABILITIES_GUIDE.md`、`pipelines/fragments/README.md`、operator runbook に実行方法、承認境界、品質報告の読み方を追加する。

## 6. 推奨実施順序

| Phase | 内容                    | 完了条件                                                             |
| ----- | ----------------------- | -------------------------------------------------------------------- |
| 1     | Task 1〜2: 契約・ゲート | DoR/AC/DoD が構造化され、waiver を含め機械判定できる                 |
| 2     | Task 3: 観点・項目設計  | 要求/リスク/品質特性の未被覆が検出される                             |
| 3     | Task 4〜5: 実行・欠陥   | 安全分類に従い実行し、結果・欠陥・再試験を追跡できる                 |
| 4     | Task 6: 品質報告        | 人間が残存リスクと証跡を見てリリース判断できる                       |
| 5     | Task 7: E2E・enforce    | 代表6シナリオが決定論的に通り、高リスク mission で gate が強制される |

## 7. 品質指標

- must-have 要求、AC、高リスク項目の traceability coverage: 100%。
- `insufficient_evidence` を pass と誤判定する件数: 0。
- blocker/critical defect が未解決または未 waiver の状態で `go`: 0。
- 実行記録の対象版・環境・主体・証跡参照の欠落率: 0%。
- AI が自己承認した waiver または release decision: 0。
- flaky test の再実行による silent pass 化: 0。
- report-only 期間で収集する運用指標: 観点追加率、重複率、false-positive、実行時間、手動試験比率、欠陥流出率、再オープン率。

## 8. リスクと注意

- 観点カタログをチェックリストとして全適用すると、コストだけが増える。適用/除外理由を要求し、mission risk と変更差分で深度を変える。
- LLM による観点抽出は網羅性を保証しない。決定論的カタログ、traceability validator、独立レビューの三層で補完する。
- 自動生成ケースは期待結果の誤りを含み得る。AC と矛盾するケースは gate で止め、仕様の誤りかケースの誤りかを人間へ提示する。
- coverage 数値、テスト件数、pass 率だけで品質を判定しない。未検証リスクと証跡の質を必ず併記する。
- 本番相当試験はデータ tier、egress、秘密情報、費用、外部副作用の統制を継承する。QA を理由に既存の承認境界を迂回しない。
- DoD はチーム/製品共通の基準、AC は変更固有の基準として分離する。両者を同じチェックリストへ潰さない。

## 9. 実装済み成果物(2026-07-12)

- 契約: `software-quality-contract` / `test-inventory` / `test-execution-record` / `defect-record` / `software-quality-report` schema。
- 観点: `software-test-viewpoints.json` に10カテゴリを正準化し、専用schemaで検証。
- 評価: `libs/core/software-quality.ts` が品質契約、DoR、AC、DoD、must-have/AC/risk traceabilityをfail-closedで判定。
- 統合: `mission-gate-engine` に `quality_contract_valid` / `dor_satisfied` / `acceptance_criteria_verified` / `dod_satisfied` / `test_traceability` を追加。
- 報告: failed/error結果からdefect candidateを生成し、証跡不足をpassにせず、最終判断を常にhuman pendingで開始する品質報告generatorを追加。
- 実行: `pnpm quality:report -- --contract ... --inventory ... --execution ... --output ...` と `pipelines/fragments/software-qa-lifecycle.json` を追加。
- 観点補完: `wisdom:derive_test_inventory` は決定論的カタログを必ず保持し、reasoning backend は新規観点だけを追加する。op registry/discoveryも正準generatorで更新。
- actuator実行: `compileTestInventoryToAdf` は `safe_auto` かつ明示automationを持つ項目だけを `code/system/browser/network` ADFへ変換。承認・手動・禁止項目はdeferredに隔離。直接dispatch APIも同じ分類を強制。
- 欠陥管理: append-only JSONLイベントで candidate→open→in_progress→fixed→retest→closed/reopened 等を管理し、`accepted_risk` はhuman actorに限定。
- operator surface: 最新品質報告をoperator homeに集約し、`human_decision=pending` をattention/next actionとして表示。
- enforce: `quality_release_allowed` mission gateがreport-only/warnでは観測し、enforceではno-go/証跡不足をブロック。
- E2E: 正常、DoR不足、AC未被覆、失敗→修正→再試験、重大欠陥残存、期限付きwaiverの6シナリオを固定。
- 検証: QA関連64テスト、typecheck、contract schema check、op registry check、core/root build、fragment実走、diff checkを通過。

## 10. 運用移行

- 初期導入は `report-only`、次に `warn` で誤検知・実行時間・手動比率を観測し、高リスクmissionから `enforce` を選ぶ。
- `go` はAIの推奨であり、operator homeに表示される `human_decision=pending` を人間が承認するまで最終リリース判断にはならない。
- 観点カタログ、actuator automation、enforce閾値は実障害と欠陥流出率をもとに継続調整する。
