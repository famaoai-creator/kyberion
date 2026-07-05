# 改善計画 実装状況正本(STATUS)

> **監査日**: 2026-07-05(全95計画を実コードと突き合わせて検証)
> **更新規約**: 計画の実装・レビュー完了時に本表を更新する。各計画文書内の「実装状況」節と矛盾する場合は本表を正とし、文書側を追従させる。
> **判定基準**: DONE = 受入条件を実コードで検証済 / PARTIAL = 一部充足 / TODO = 実質未着手。

## サマリ

| 判定    | 件数 |
| ------- | ---- |
| DONE    | 26   |
| PARTIAL | 24   |
| TODO    | 45   |

## P0 残作業(プロダクション化のクリティカルパス)

| ID    | 状態    | 残作業の要点                                                                                                         |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| IP-07 | PARTIAL | claude-agent-reasoning-backend テスト、surface-runtime-orchestrator 特性化テスト                                     |
| MO-01 | PARTIAL | プロセステンプレート機構(schema・4テンプレート・worker のテンプレート駆動化)                                         |
| MO-02 | PARTIAL | mission-gate-engine、新設ゲート共通化、planning/受入ゲート記録、受入 rework/owner 通知、exit/quality の修復ループ    |
| AA-02 | TODO    | mesh_delivery_driver 新設、broker⇔dispatchToPeer 配線、writer fencing、E2E                                           |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce 到達                                                             |
| SA-05 | PARTIAL | policyEngine の操作種別拡張、secure-io parse失敗 fail-open 解消、-y 破壊操作除外                                     |
| OP-01 | TODO    | 全推論経路の usage 計測、cost report、spend-guard、KPI 接続                                                          |
| AR-01 | TODO    | adf-engine.ts 抽出、3エンジン統合、golden 回帰                                                                       |
| AR-02 | TODO    | describeOps、generate_op_registry、CI ゲート                                                                         |
| AO-02 | TODO    | CVE スキャン/台帳、パッチ判断ルーブリック、適用フロー                                                                |
| IL-01 | TODO    | goal/source_text/outcome_ids の昇格 seam 貫通、outcome-contract の goal 優先化                                       |
| IL-04 | PARTIAL | intent-reconciliation エンジン、task-session 完了ゲート、completion summary/next action、intent-contract-memory 記録 |

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

| ID    | 状態    | 残作業                                                                      |
| ----- | ------- | --------------------------------------------------------------------------- |
| UX-01 | DONE    |                                                                             |
| UX-02 | PARTIAL | 4ブリッジ typing 表示、chronos チャットのキャンセル+フェーズ表示            |
| UX-03 | PARTIAL | locale-resolver 一元化、onboarding/cli help の ja/en 化、chronos 言語トグル |
| UX-04 | PARTIAL | CLI 承認動詞統一、魔法語の選択肢化、decidedBy を identity から取得          |
| UX-05 | PARTIAL | 契約スナップショットテスト+CI ゲート、dashboard の renderStatus 経由化      |
| UX-06 | DONE    | (軽微: 3面バナーの版数統一)                                                 |

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

| ID    | 状態    | 残作業                                                                                                            |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| MO-01 | PARTIAL | プロセステンプレート機構一式(schema/テンプレ/worker 駆動化)                                                       |
| MO-02 | PARTIAL | mission-gate-engine、新設ゲート共通化、planning/受入ゲート記録、受入 rework/owner 通知、exit/quality の修復ループ |
| MO-03 | DONE    |                                                                                                                   |
| MO-04 | DONE    |                                                                                                                   |
| MO-05 | DONE    | (軽微: 集計スクリプト)                                                                                            |
| MO-06 | DONE    |                                                                                                                   |
| MO-07 | PARTIAL | tier 昇格連動の再実行、media draft→refine                                                                         |

### DS(デザインシステム)

| ID    | 状態    | 残作業                                                                    |
| ----- | ------- | ------------------------------------------------------------------------- |
| DS-01 | PARTIAL | 生成ゲートの validate チェーン接続、operator-surface 残り約124 hex の変換 |
| DS-02 | PARTIAL | tier 隔離テスト(受入4)、DESIGN_SYSTEM.md テナント節                       |
| DS-03 | DONE    | pptx ea 日本語フォント、PDF CJK 埋め込み、日文ゴールデン                  |
| DS-04 | PARTIAL | 動画シーンテンプレートの var(--kb-\*) 化、Task 4 の実写検証待ち            |
| DS-05 | TODO    | reduced-motion、コントラストゲート、light/dark トグル、ARIA               |

### AA(エージェント間通信)

| ID    | 状態    | 残作業                                                    |
| ----- | ------- | --------------------------------------------------------- |
| AA-01 | DONE    |                                                           |
| AA-02 | TODO    | mesh_delivery_driver、writer fencing、2-peer E2E          |
| AA-03 | PARTIAL | 署名モジュール+秘密永続化、warn→enforce、鍵運用文書       |
| AA-04 | TODO    | 会話ストア、rehydrate、inflight admission                 |
| AA-05 | PARTIAL | mission flow コマンド、file 版 transport の quarantine 化 |

### SA(セキュリティ・監査)

| ID    | 状態    | 残作業                                                               |
| ----- | ------- | -------------------------------------------------------------------- |
| SA-01 | DONE    | (残: audit-continuity の --warn-only → enforce)                      |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce                  |
| SA-03 | TODO    | untrusted-content.ts、インジェクション検知、汚染文脈ゲート           |
| SA-04 | PARTIAL | tier 文脈付き egress ゲート、DNS リバインディング対策                |
| SA-05 | PARTIAL | policyEngine 操作種別拡張、secure-io fail-open 解消、-y 破壊操作除外 |

### OP(運用・配布)

| ID    | 状態    | 残作業                                                   |
| ----- | ------- | -------------------------------------------------------- |
| OP-01 | TODO    | usage 計測、cost report、spend-guard                     |
| OP-02 | DONE    | (残: 外部ボリューム定期運用の実績)                       |
| OP-03 | PARTIAL | bin フィールド+CLI、docker deploy サービス               |
| OP-04 | TODO    | 劣化検知ループ、healthz/status、provider-health 永続化   |
| OP-05 | TODO    | env-registry、起動時検証、CONFIGURATION.md、.env.example |

### AO(自律運用・保守)

| ID    | 状態    | 残作業                                      |
| ----- | ------- | ------------------------------------------- |
| AO-01 | PARTIAL | auto-checkpoint、統合 self-maintenance loop |
| AO-02 | PARTIAL | 適用フロー、見送り再評価ループ              |
| AO-03 | DONE    |                                             |
| AO-04 | DONE    |                                             |

### IL(インテントライフサイクル)

| ID    | 状態    | 残作業                                                                                                               |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| IL-01 | TODO    | goal の昇格 seam 貫通、outcome-contract の goal 優先化                                                               |
| IL-02 | PARTIAL | intent trace コマンド、相関 ID 貫通の接続面                                                                          |
| IL-03 | TODO    | origin baseline、実行中ドリフトゲート                                                                                |
| IL-04 | PARTIAL | intent-reconciliation エンジン、task-session 完了ゲート、completion summary/next action、intent-contract-memory 記録 |
| IL-05 | TODO    | pending-intent-store、修正検知、completed 再オープン                                                                 |

### ONB(初回オンボーディング)

| ID     | 状態 | 残作業                                                                              |
| ------ | ---- | ----------------------------------------------------------------------------------- |
| ONB-01 | DONE |                                                                                     |
| ONB-02 | DONE | (2026-07-05 完了: Node 24 統一・floor probe・Playwright 非致命警告・正本リンク統一) |
| ONB-03 | TODO | express、onboard:reset、identity.example.json、vital-check の overlay 対応          |

### SU(Surface UI)

| ID    | 状態 | 残作業                                                   |
| ----- | ---- | -------------------------------------------------------- |
| SU-01 | TODO | plan-preview API、オペレータホーム(IL-01/04, MO-01 依存) |
| SU-02 | TODO | pause/cancel/intervention_respond、kb-panel 配線         |
| SU-03 | TODO | 成果物インボックス、verdict、版管理                      |
| SU-04 | TODO | 履歴検索、コスト UI、承認キュー(OP-01 依存)              |

### E2E(オペレータ接点の最小統合)

| ID     | 状態 | 残作業                                       |
| ------ | ---- | -------------------------------------------- |
| E2E-01 | DONE | 会議→価値提供の縦一気通貫(Task 1-7 実装済み) |
| E2E-04 | DONE |                                              |

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
