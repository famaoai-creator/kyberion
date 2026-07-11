# 改善計画 実装状況正本(STATUS)

> **監査日**: 2026-07-05(全93計画を実コードと突き合わせて検証)/ 2026-07-06 MO-01 を DONE に更新
> **更新規約**: 計画の実装・レビュー完了時に本表を更新する。各計画文書内の「実装状況」節と矛盾する場合は本表を正とし、文書側を追従させる。
> **判定基準**: DONE = 受入条件を実コードで検証済 / PARTIAL = 一部充足 / TODO = 実質未着手。

## サマリ

| 判定    | 件数 |
| ------- | ---- |
| DONE    | 38   |
| PARTIAL | 38   |
| TODO    | 19   |

## P0 残作業(プロダクション化のクリティカルパス)

| ID    | 状態    | 残作業の要点                                                                                                                                                                     |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-07 | PARTIAL | claude-agent-reasoning-backend テスト、surface-runtime-orchestrator 特性化テスト                                                                                                 |
| MO-01 | DONE    | 2026-07-06 完了: phaseSpec スキーマ(catalog v1.1.0)+タスク展開(plan-tasks/createMission)+3プロセステンプレート追加。worker イベント連鎖のフェーズ駆動化は計画どおり MO-02 に委譲 |
| MO-02 | PARTIAL | mission-gate-engine、新設ゲート共通化、planning/受入ゲート記録、受入 rework/owner 通知、exit/quality の修復ループ                                                                |
| AA-02 | TODO    | mesh_delivery_driver 新設、broker⇔dispatchToPeer 配線、writer fencing、E2E                                                                                                       |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce 到達(environment manifest の HMAC 署名は 2026-07-11 実装: KYBERION_MANIFEST_SIGNING_KEY 設定で fail-closed)                  |
| SA-05 | PARTIAL | policyEngine の操作種別拡張、secure-io parse失敗 fail-open 解消、-y 破壊操作除外                                                                                                 |
| OP-01 | PARTIAL | usage 計測の全経路接続、cost report、spend-guard、KPI 接続                                                                                                                       |
| AR-01 | PARTIAL | adf-engine.ts 抽出、file-actuator/super-nerve アダプタ化、3エンジン統合、golden 回帰                                                                                             |
| AR-02 | PARTIAL | describeOps、op-discovery に input_schema 反映、未知 op の apply 既定撤廃(check:op-registry は 2026-07-11 に修復し validate/CI へ接続済み)                                       |
| AO-02 | TODO    | CVE スキャン/台帳、パッチ判断ルーブリック、適用フロー                                                                                                                            |
| IL-01 | TODO    | goal/source_text/outcome_ids の昇格 seam 貫通、outcome-contract の goal 優先化                                                                                                   |
| IL-04 | PARTIAL | intent-reconciliation エンジン、完了ゲート、学習記録                                                                                                                             |

## 全計画一覧

### IP(コード品質)

| ID    | 状態    | 残作業(PARTIAL/TODO のみ)                                                                      |
| ----- | ------- | ---------------------------------------------------------------------------------------------- |
| IP-01 | DONE    |                                                                                                |
| IP-02 | DONE    |                                                                                                |
| IP-03 | DONE    |                                                                                                |
| IP-04 | PARTIAL | schemas/ 直下 \*-pipeline.schema.json 11本の二重定義整理                                       |
| IP-05 | DONE    |                                                                                                |
| IP-06 | DONE    |                                                                                                |
| IP-07 | PARTIAL | claude-agent-reasoning-backend テスト、orchestrator 特性化、operator-learning テスト           |
| IP-08 | PARTIAL | installProcessGuards 全デーモン適用、空 catch 解消、no-empty/process.exit lint、console→logger |
| IP-09 | PARTIAL | slugify ローカル定義5箇所の正本 import 化、再発防止 lint                                       |
| IP-10 | TODO    | 巨大5+2ファイルの分割(check_contract_schemas 5191行、MissionIntelligence 5526行 ほか)          |
| IP-11 | PARTIAL | strict 系フラグ有効化、@ts-ignore 残6、media-actuator any 半減                                 |
| IP-12 | DONE    |                                                                                                |
| IP-13 | DONE    |                                                                                                |
| IP-14 | DONE    |                                                                                                |

### UX(ユーザー接点)

| ID    | 状態    | 残作業                                                                                                                                         |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-01 | DONE    |                                                                                                                                                |
| UX-02 | PARTIAL | 4ブリッジ typing 表示(chronos チャットのキャンセル+フェーズ表示は 2026-07-11 実装済み)                                                         |
| UX-03 | PARTIAL | locale-resolver 一元化、onboarding/cli help の ja/en 化(wizard の identity/reasoning は 2026-07-11 に選択言語へ即時追従化)、chronos 言語トグル |
| UX-04 | PARTIAL | CLI 承認動詞統一、魔法語の選択肢化、decidedBy を identity から取得                                                                             |
| UX-05 | PARTIAL | 契約スナップショットテスト+CI ゲート、dashboard の renderStatus 経由化                                                                         |
| UX-06 | DONE    | (軽微: 3面バナーの版数統一)                                                                                                                    |

### AC(アクチュエータ能力)

| ID    | 状態    | 残作業                                                    |
| ----- | ------- | --------------------------------------------------------- |
| AC-01 | DONE    |                                                           |
| AC-02 | PARTIAL | browser fill フォールバック、4系統 reconciled 化の E2E    |
| AC-03 | DONE    |                                                           |
| AC-04 | PARTIAL | gws/backend 抽象層(非 macOS 対応)、gws セッションプローブ |
| AC-05 | TODO    | OAuth プリセット拡大、保存時暗号化、kintone パイロット    |
| AC-06 | PARTIAL | 能力境界表の実体化(GLOSSARY 断リンク解消)                 |

### KM(ナレッジ/メモリ)

| ID    | 状態 | 残作業                                                           |
| ----- | ---- | ---------------------------------------------------------------- |
| KM-01 | DONE |                                                                  |
| KM-02 | TODO | 本文チャンク索引+差分更新、縮退モード可視化、非 Mac 埋め込み経路 |
| KM-03 | DONE |                                                                  |
| KM-04 | DONE |                                                                  |

### MO(ミッション・オーケストレーション)

| ID    | 状態    | 残作業                                                                                                                                               |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO-01 | DONE    | (worker イベント連鎖のフェーズ駆動化は MO-02 側で実施。gate-pass 機械評価・entry_gate deferral・deliverable_quality check は MO-01 側で先行実装済み) |
| MO-02 | PARTIAL | mission-gate-engine、新設ゲート共通化、planning/受入ゲート記録、受入 rework/owner 通知、exit/quality の修復ループ                                    |
| MO-03 | PARTIAL | mission-task-contract.schema.json + planner 出力検証+循環検出                                                                                        |
| MO-04 | DONE    |                                                                                                                                                      |
| MO-05 | DONE    | (軽微: 集計スクリプト)                                                                                                                               |
| MO-06 | DONE    |                                                                                                                                                      |
| MO-07 | PARTIAL | tier 昇格連動の再実行、media draft→refine                                                                                                            |

### DS(デザインシステム)

| ID    | 状態    | 残作業                                                                    |
| ----- | ------- | ------------------------------------------------------------------------- |
| DS-01 | PARTIAL | 生成ゲートの validate チェーン接続、operator-surface 残り約124 hex の変換 |
| DS-02 | PARTIAL | tier 隔離テスト(受入4)、DESIGN_SYSTEM.md テナント節                       |
| DS-03 | DONE    | pptx ea 日本語フォント、PDF サブセット埋め込み、日本語ゴールデン          |
| DS-04 | TODO    | 動画シーンテンプレートの var(--kb-\*) 化                                  |
| DS-05 | DONE    | reduced-motion、コントラストゲート、light/dark トグル、ARIA               |

### AA(エージェント間通信)

| ID    | 状態    | 残作業                                                    |
| ----- | ------- | --------------------------------------------------------- |
| AA-01 | DONE    |                                                           |
| AA-02 | TODO    | mesh_delivery_driver、writer fencing、2-peer E2E          |
| AA-03 | PARTIAL | 署名モジュール+秘密永続化、warn→enforce、鍵運用文書       |
| AA-04 | TODO    | 会話ストア、rehydrate、inflight admission                 |
| AA-05 | PARTIAL | mission flow コマンド、file 版 transport の quarantine 化 |

### AR(アクチュエータリファクタリング/使いやすさ)

| ID    | 状態    | 残作業                                                                                                                                                                                    |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-01 | PARTIAL | adf-engine.ts 抽出、file-actuator/super-nerve アダプタ化、3エンジン統合、golden 回帰                                                                                                      |
| AR-02 | PARTIAL | describeOps、op-discovery に input_schema 反映、未知 op の apply 既定撤廃(check:op-registry は 2026-07-11 に修復し validate/CI へ接続済み)                                                |
| AR-03 | PARTIAL | write_artifact/path 前倒し検証、notify/read_file/read_json/open_file 含む op_input_contracts、generate_op_registry/discovery 反映、browser/file/system の契約 coverage 検査、主要 op 検証 |
| AR-04 | PARTIAL | canonical op family 定義、browser alias 共通化、browser/system の正規化と警告                                                                                                             |
| AR-05 | PARTIAL | system file I/O の file-actuator forward、観察/変更・ドメイン境界の分割準備                                                                                                               |
| AR-06 | PARTIAL | teach message(shared helper で network/orchestrator/file/system へ展開)、skipped 明示化(run_pipeline 含む)、silent default 回帰検知、AR-01 集約                                           |

### SA(セキュリティ・監査)

| ID    | 状態    | 残作業                                                               |
| ----- | ------- | -------------------------------------------------------------------- |
| SA-01 | DONE    | (残: audit-continuity の --warn-only → enforce)                      |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce                  |
| SA-03 | TODO    | untrusted-content.ts、インジェクション検知、汚染文脈ゲート           |
| SA-04 | PARTIAL | tier 文脈付き egress ゲート、DNS リバインディング対策                |
| SA-05 | PARTIAL | policyEngine 操作種別拡張、secure-io fail-open 解消、-y 破壊操作除外 |

### OP(運用・配布)

| ID    | 状態    | 残作業                                                                                                                                                                                                                             |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OP-01 | TODO    | usage 計測、cost report、spend-guard                                                                                                                                                                                               |
| OP-02 | DONE    | (残: 外部ボリューム定期運用の実績)                                                                                                                                                                                                 |
| OP-03 | PARTIAL | bin フィールド+CLI、docker deploy サービス                                                                                                                                                                                         |
| OP-04 | TODO    | 劣化検知ループ、healthz/status、provider-health 永続化                                                                                                                                                                             |
| OP-05 | PARTIAL | 2026-07-11: env-registry(228変数)+ check:env-registry(validate/CI)+ env-validator + doctor 配線 + env.example/CONFIGURATION.md 生成。残: 棚卸しの継続キュレーション(documented=false 211件)、baseline-check 接続、集中ローダー移行 |

### AO(自律運用・保守)

| ID    | 状態    | 残作業                                                                              |
| ----- | ------- | ----------------------------------------------------------------------------------- |
| AO-01 | PARTIAL | scheduler run-lock/missed-run catch-up、autonomous-ops-policy/gate、auto-checkpoint |
| AO-02 | TODO    | CVE スキャン/台帳、パッチルーブリック、適用フロー                                   |
| AO-03 | DONE    |                                                                                     |
| AO-04 | TODO    | soak ハーネス、リーク検出、再起動 e2e                                               |

### IL(インテントライフサイクル)

| ID    | 状態    | 残作業                                                 |
| ----- | ------- | ------------------------------------------------------ |
| IL-01 | TODO    | goal の昇格 seam 貫通、outcome-contract の goal 優先化 |
| IL-02 | TODO    | 相関 ID 貫通、intent trace コマンド                    |
| IL-03 | TODO    | origin baseline、実行中ドリフトゲート                  |
| IL-04 | PARTIAL | intent-reconciliation エンジン、完了ゲート、学習記録   |
| IL-05 | TODO    | pending-intent-store、修正検知、completed 再オープン   |

### ONB(初回オンボーディング)

| ID     | 状態    | 残作業                                                                                |
| ------ | ------- | ------------------------------------------------------------------------------------- |
| ONB-01 | DONE    |                                                                                       |
| ONB-02 | DONE    | (2026-07-05 完了: Node 24 統一・floor probe・Playwright 非致命警告・正本リンク統一)   |
| ONB-03 | PARTIAL | onboard:reset を追加。残: express、identity.example.json、vital-check の overlay 対応 |

### SU(Surface UI)

| ID    | 状態 | 残作業                                                                 |
| ----- | ---- | ---------------------------------------------------------------------- |
| SU-01 | DONE | plan-preview API、オペレータホーム、goal/persona/tier 編集、承認開始   |
| SU-02 | DONE | pause/cancel/intervention_respond、kb-panel 配線、mission control 連携 |
| SU-03 | DONE | 成果物インボックス、verdict、request-changes 版管理、レビュー UI       |
| SU-04 | DONE | 履歴検索、コスト UI、承認キュー、テナント/接続レビュー                 |

### HO(ハンドオフ)

| ID    | 状態 | 残作業                                                                    |
| ----- | ---- | ------------------------------------------------------------------------- |
| HO-01 | DONE | self-contained handoff packet、approval framing、hand-off summary capture |
| HO-02 | TODO | AiDlcPhaseState、work history 統合ビュー                                  |

### HN(ハーネス)

| ID    | 状態 | 残作業                                                                          |
| ----- | ---- | ------------------------------------------------------------------------------- |
| HN-01 | DONE |                                                                                 |
| HN-02 | DONE |                                                                                 |
| HN-03 | DONE | workflow-as-code 第一級経路(run_pipeline の workflow module 入力化、SA-02 整合) |

### CO(Company OS)

| ID    | 状態 | 残作業                                                               |
| ----- | ---- | -------------------------------------------------------------------- |
| CO-01 | TODO | company schema/entity、vision-resolver、getGoldenRule のテナント対応 |
| CO-02 | TODO | org-chart、カスタムロール作成フロー                                  |
| CO-03 | TODO | financial-model、okr-tracker                                         |
| CO-04 | TODO | decision-rights、承認ゲート統合                                      |
| CO-05 | TODO | 基幹業務テンプレート(決算/取締役会/採用/調達 等)                     |
