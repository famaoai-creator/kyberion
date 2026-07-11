# 改善計画 実装状況正本(STATUS)

> **監査日**: 2026-07-05(全93計画を実コードと突き合わせて検証)/ 2026-07-06 MO-01 を DONE に更新 / 2026-07-11 IP-07・AA-02 行の陳腐化を再突合で訂正 / 同日 TODO 全18行を機械突合し 11 ID(SA-03/OP-01/IL-01/02/03/05/AO-04/AA-04/CO-01〜04)を PARTIAL へ訂正(実装+緑テストを確認。KM-02/DS-04/HO-02/CO-05/AC-05/IP-10 は真に未了と再確認)
> **更新規約**: 計画の実装・レビュー完了時に本表を更新する。各計画文書内の「実装状況」節と矛盾する場合は本表を正とし、文書側を追従させる。
> **判定基準**: DONE = 受入条件を実コードで検証済 / PARTIAL = 一部充足 / TODO = 実質未着手。

## サマリ

| 判定    | 件数 |
| ------- | ---- |
| DONE    | 36   |
| PARTIAL | 53   |
| TODO    | 0    |

## P0 残作業(プロダクション化のクリティカルパス)

| ID    | 状態    | 残作業の要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-07 | PARTIAL | 2026-07-11 突合: claude-agent-reasoning-backend.test.ts(6件緑)と orchestrator の delegation/fastpath テストは実在し緑 — 旧記載の残作業は解消済み。残: 受入条件全体との網羅精査                                                                                                                                                                                                                                                                                                                            |
| MO-01 | DONE    | 2026-07-06 完了: phaseSpec スキーマ(catalog v1.1.0)+タスク展開(plan-tasks/createMission)+3プロセステンプレート追加。worker イベント連鎖のフェーズ駆動化は計画どおり MO-02 に委譲                                                                                                                                                                                                                                                                                                                          |
| MO-02 | PARTIAL | mission-gate-engine、新設ゲート共通化、planning/受入ゲート記録、受入 rework/owner 通知、exit/quality の修復ループ                                                                                                                                                                                                                                                                                                                                                                                         |
| AA-02 | DONE    | 2026-07-11 完了: driver/dispatchToPeer/writer fencing に加え、2-peer E2E(実 HTTP+HMAC、正常配送・復帰再配送・dead-letter・dedup)を実装。物理2プロセス実証のみ E3 パイロットへ                                                                                                                                                                                                                                                                                                                             |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce 到達(environment manifest の HMAC 署名は 2026-07-11 実装: KYBERION_MANIFEST_SIGNING_KEY 設定で fail-closed)                                                                                                                                                                                                                                                                                                                                           |
| SA-05 | PARTIAL | policyEngine の操作種別拡張、secure-io parse失敗 fail-open 解消、-y 破壊操作除外                                                                                                                                                                                                                                                                                                                                                                                                                          |
| OP-01 | PARTIAL | usage 計測の全経路接続、cost report、spend-guard、KPI 接続                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AR-01 | PARTIAL | adf-engine.ts 抽出、file-actuator/super-nerve アダプタ化、3エンジン統合、golden 回帰                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AR-02 | PARTIAL | describeOps、op-discovery に input_schema 反映、未知 op の apply 既定撤廃(check:op-registry は 2026-07-11 に修復し validate/CI へ接続済み)                                                                                                                                                                                                                                                                                                                                                                |
| AO-02 | PARTIAL | 2026-07-11: scan/台帳/ルーブリック実装済み + §3.3 unit test + 適用フロー(propose 既定・--apply で backup→bump→install/typecheck/smoke→再スキャン→確定/ロールバック)。カナリアも 2026-07-11 接続済み(確定後に runDegradationWatch、台帳へ verdict 記録)→ AO-02 は全タスク完了。透過依存は 2026-07-11 に --override(pnpm.overrides 経由、明示オプトイン)で対応済み。日次スキャンは pipelines/dependency-vuln-scan.json の cron(JST 5:00)で配線済み・実走確認済み。Task 4 defer 再評価は 2026-07-11 実装済み |
| IL-01 | PARTIAL | 2026-07-11 突合: outcome-contract.ts に intentGoal 貫通が実装済み(IL-01 注記付き、テスト緑)。残: 全 seam の網羅精査                                                                                                                                                                                                                                                                                                                                                                                       |
| IL-04 | PARTIAL | intent-reconciliation エンジン、完了ゲート、学習記録                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 全計画一覧

### IP(コード品質)

| ID    | 状態    | 残作業(PARTIAL/TODO のみ)                                                                                                                                                                                      |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-01 | DONE    |                                                                                                                                                                                                                |
| IP-02 | DONE    |                                                                                                                                                                                                                |
| IP-03 | DONE    |                                                                                                                                                                                                                |
| IP-04 | PARTIAL | schemas/ 直下 \*-pipeline.schema.json 11本の二重定義整理                                                                                                                                                       |
| IP-05 | DONE    |                                                                                                                                                                                                                |
| IP-06 | DONE    |                                                                                                                                                                                                                |
| IP-07 | PARTIAL | 2026-07-11 突合: backend/orchestrator/operator-learning のテストは実在し緑。残: 受入条件全体との網羅精査                                                                                                       |
| IP-08 | PARTIAL | installProcessGuards 全デーモン適用、空 catch 解消、no-empty/process.exit lint、console→logger                                                                                                                 |
| IP-09 | PARTIAL | slugify ローカル定義5箇所の正本 import 化、再発防止 lint                                                                                                                                                       |
| IP-10 | PARTIAL | 2026-07-11: check_contract_schemas から policy/manifest 系46チェック(1,170行)を \_policy_checks へ抽出(4,684→3,527行、check:contract-schemas 実走で同一動作を確認)。残: 同ファイルの継続分割と他の巨大ファイル |
| IP-11 | PARTIAL | strict 系フラグ有効化、@ts-ignore 残6、media-actuator any 半減                                                                                                                                                 |
| IP-12 | DONE    |                                                                                                                                                                                                                |
| IP-13 | DONE    |                                                                                                                                                                                                                |
| IP-14 | DONE    |                                                                                                                                                                                                                |

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

| ID    | 状態    | 残作業                                                                                                                                                                                                            |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | DONE    |                                                                                                                                                                                                                   |
| AC-02 | PARTIAL | browser fill フォールバック、4系統 reconciled 化の E2E                                                                                                                                                            |
| AC-03 | DONE    |                                                                                                                                                                                                                   |
| AC-04 | PARTIAL | gws/backend 抽象層(非 macOS 対応)、gws セッションプローブ                                                                                                                                                         |
| AC-05 | PARTIAL | 2026-07-11: 保存時暗号化を実装(KYBERION_SECRET_ENCRYPTION=keychain、AES-256-GCM+keychain KEK、読込自動判別、pnpm secrets:encrypt/--decrypt、テスト付き)。残: OAuth プリセット拡大、kintone パイロット、age モード |
| AC-06 | PARTIAL | 能力境界表の実体化(GLOSSARY 断リンク解消)                                                                                                                                                                         |

### KM(ナレッジ/メモリ)

| ID    | 状態    | 残作業                                                                                                                                                                                                         |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KM-01 | DONE    |                                                                                                                                                                                                                |
| KM-02 | PARTIAL | 2026-07-11: 本文チャンク索引(~1000字・文書集約・戻り型互換)と縮退可視化(embeddingBackend メタ + doctor DEGRADED 表示)を実装。残: キャッシュ差分/LRU、before/after fixture、非 Mac 実埋め込み経路、ランカー統合 |
| KM-03 | DONE    |                                                                                                                                                                                                                |
| KM-04 | DONE    |                                                                                                                                                                                                                |

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

| ID    | 状態    | 残作業                                                                                                                                                                        |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DS-01 | PARTIAL | 生成ゲートの validate チェーン接続、operator-surface 残り約124 hex の変換                                                                                                     |
| DS-02 | PARTIAL | tier 隔離テスト(受入4)、DESIGN_SYSTEM.md テナント節                                                                                                                           |
| DS-03 | DONE    | pptx ea 日本語フォント、PDF サブセット埋め込み、日本語ゴールデン                                                                                                              |
| DS-04 | PARTIAL | 2026-07-11 突合: Task 1〜3 実装済み(compiler に 98 トークン、共有変数 54、テスト16件緑 — #490 の負検証は対象ディレクトリ誤り)。残: Task 4 テナント実写検証(DS-02 Task 3 依存) |
| DS-05 | DONE    | reduced-motion、コントラストゲート、light/dark トグル、ARIA                                                                                                                   |

### AA(エージェント間通信)

| ID    | 状態    | 残作業                                                                                             |
| ----- | ------- | -------------------------------------------------------------------------------------------------- |
| AA-01 | DONE    |                                                                                                    |
| AA-02 | DONE    | 2026-07-11 完了(2-peer E2E 含む。物理2プロセス実証は E3 パイロットへ)                              |
| AA-03 | PARTIAL | 署名モジュール+秘密永続化、warn→enforce、鍵運用文書                                                |
| AA-04 | PARTIAL | 2026-07-11 突合: a2a-conversation-store.ts(rehydrate 含む)+ テスト実在・緑。残: inflight admission |
| AA-05 | PARTIAL | mission flow コマンド、file 版 transport の quarantine 化                                          |

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

| ID    | 状態    | 残作業                                                                                                       |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------ |
| SA-01 | DONE    | (残: audit-continuity の --warn-only → enforce)                                                              |
| SA-02 | PARTIAL | execution-bounds.ts 抽出、SECURITY.md、warn→enforce                                                          |
| SA-03 | PARTIAL | 2026-07-11 突合: untrusted-content.ts + テスト実在(injection 検知含む、緑)。残: 汚染文脈ゲートの適用範囲精査 |
| SA-04 | PARTIAL | tier 文脈付き egress ゲート、DNS リバインディング対策                                                        |
| SA-05 | PARTIAL | policyEngine 操作種別拡張、secure-io fail-open 解消、-y 破壊操作除外                                         |

### OP(運用・配布)

| ID    | 状態    | 残作業                                                                                                                                                                                                                                                                                               |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OP-01 | PARTIAL | spend-guard は 2026-07-11 実装(spend-policy.json、warn 既定/block で SpendCapExceededError、reasoning failover 前段に配線、日次 dedupe アラート)。usage 計測も 2026-07-11 に全経路接続(anthropic SDK は実 usage、gemini/codex CLI は estimated 概算)。残: cost report CLI(Task 2)、テナント override |
| OP-02 | DONE    | (残: 外部ボリューム定期運用の実績)                                                                                                                                                                                                                                                                   |
| OP-03 | PARTIAL | bin フィールド+CLI、docker deploy サービス                                                                                                                                                                                                                                                           |
| OP-04 | PARTIAL | 残: RSS/restart 履歴の拡張と soak 実証のみ(劣化検知ループ・hourly cron・doctor rollup・healthz/status API・provider-health 永続化は 2026-07-11 実装: runtime state ファイル + TTL 自然回復 + reload API、vitest 下は隔離必須)                                                                        |
| OP-05 | PARTIAL | 2026-07-11: env-registry(228変数)+ check:env-registry(validate/CI)+ env-validator + doctor 配線 + env.example/CONFIGURATION.md 生成。残: 棚卸しの継続キュレーション(documented=false 211件)、baseline-check 接続、集中ローダー移行                                                                   |

### AO(自律運用・保守)

| ID    | 状態    | 残作業                                                                                                                                                                                                                                         |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AO-01 | PARTIAL | scheduler run-lock/missed-run catch-up、autonomous-ops-policy/gate、auto-checkpoint                                                                                                                                                            |
| AO-02 | PARTIAL | 2026-07-11: scan/台帳/ルーブリック実装済み + §3.3 unit test + 適用フロー(propose 既定・--apply で backup→bump→install/typecheck/smoke→再スキャン→確定/ロールバック)。適用フロー・--override・defer 再評価まで実装済み。残: カナリア監視(OP-04) |
| AO-03 | DONE    |                                                                                                                                                                                                                                                |
| AO-04 | PARTIAL | 2026-07-11 突合: scripts/soak_restart_e2e.ts と pipelines/soak-endurance.json は実在。残: リーク検出、30日エビデンス                                                                                                                           |

### IL(インテントライフサイクル)

| ID    | 状態    | 残作業                                                                                              |
| ----- | ------- | --------------------------------------------------------------------------------------------------- |
| IL-01 | PARTIAL | outcome-contract の goal 貫通は実装済み(2026-07-11 突合)。残: 全 seam 網羅精査                      |
| IL-02 | PARTIAL | 2026-07-11 突合: scripts/intent_trace.ts(pnpm intent:trace)実在。残: 相関 ID の全経路貫通精査       |
| IL-03 | PARTIAL | 2026-07-11 突合: intent-delta.ts(goalSimilarity 起点比較)+ テスト実在・緑。残: 実行中ドリフトゲート |
| IL-04 | PARTIAL | intent-reconciliation エンジン、完了ゲート、学習記録                                                |
| IL-05 | PARTIAL | 2026-07-11 突合: pending-intent-store.ts + テスト実在・緑。残: 修正検知/completed 再オープンの精査  |

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

| ID    | 状態    | 残作業                                                                                                                                                                       |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HO-01 | DONE    | self-contained handoff packet、approval framing、hand-off summary capture                                                                                                    |
| HO-02 | PARTIAL | 2026-07-11: AiDlcPhaseState(順序遷移・状態継承・circuit breaker+failure_context・mission evidence 永続化)を実装。残: MO-01 テンプレ配線、work history 統合ビュー、clean 再開 |

### HN(ハーネス)

| ID    | 状態 | 残作業                                                                          |
| ----- | ---- | ------------------------------------------------------------------------------- |
| HN-01 | DONE |                                                                                 |
| HN-02 | DONE |                                                                                 |
| HN-03 | DONE | workflow-as-code 第一級経路(run_pipeline の workflow module 入力化、SA-02 整合) |

### CO(Company OS)

| ID    | 状態    | 残作業                                                                                                                                                |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CO-01 | PARTIAL | 2026-07-11 突合: company.ts と vision-resolver.ts は実装・テスト済み。残: getGoldenRule のテナント対応精査                                            |
| CO-02 | PARTIAL | 2026-07-11 突合: org-chart.ts + テスト実在・緑。残: カスタムロール作成フロー精査                                                                      |
| CO-03 | PARTIAL | 2026-07-11 突合: financial-model.ts / okr-tracker.ts + テスト実在・緑。残: 経営判断への接続精査                                                       |
| CO-04 | PARTIAL | 2026-07-11 突合: decision-rights.ts + テスト実在・緑。残: 承認ゲート統合精査                                                                          |
| CO-05 | PARTIAL | 2026-07-11 突合: カタログに35テンプレート(採用/決算/調達/取締役会/資金調達を完備)+専用契約テスト緑(#490 の負検証はキー名誤り)。残: 受入条件の粒度精査 |
