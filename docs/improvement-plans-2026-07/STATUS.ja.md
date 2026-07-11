# 改善計画 実装状況正本(STATUS)

> **監査日**: 2026-07-05(全93計画を実コードと突き合わせて検証)/ 2026-07-06 MO-01 を DONE に更新 / 2026-07-11 IP-07・AA-02 行の陳腐化を再突合で訂正 / 同日 TODO 全18行を機械突合し 11 ID(SA-03/OP-01/IL-01/02/03/05/AO-04/AA-04/CO-01〜04)を PARTIAL へ訂正(実装+緑テストを確認。KM-02/DS-04/HO-02/CO-05/AC-05/IP-10 は真に未了と再確認)/ 2026-07-12 SA-02 行の陳腐化を再突合で訂正(残とされた3点は実装済み・19テスト緑を確認)
> **更新規約**: 計画の実装・レビュー完了時に本表を更新する。各計画文書内の「実装状況」節と矛盾する場合は本表を正とし、文書側を追従させる。
> **判定基準**: DONE = 受入条件を実コードで検証済 / PARTIAL = 一部充足 / TODO = 実質未着手。

## サマリ

| 判定    | 件数 |
| ------- | ---- |
| DONE    | 42   |
| PARTIAL | 49   |
| TODO    | 0    |

## P0 残作業(プロダクション化のクリティカルパス)

| ID    | 状態    | 残作業の要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-07 | PARTIAL | 2026-07-11 突合: claude-agent-reasoning-backend.test.ts(6件緑)と orchestrator の delegation/fastpath テストは実在し緑 — 旧記載の残作業は解消済み。残: 受入条件全体との網羅精査                                                                                                                                                                                                                                                                                                                            |
| MO-01 | DONE    | 2026-07-06 完了: phaseSpec スキーマ(catalog v1.1.0)+タスク展開(plan-tasks/createMission)+3プロセステンプレート追加。worker イベント連鎖のフェーズ駆動化は計画どおり MO-02 に委譲                                                                                                                                                                                                                                                                                                                          |
| MO-02 | PARTIAL | 2026-07-12 再突合+実装: gate-engine/計画・受入ゲート/finish 修復ループ/override 記録は実装済みだった。フェーズ exit ゲートの実行時評価を新設(completion 前、既定 warn → KYBERION_PHASE_GATE_MODE=enforce でブロック、3回失敗で circuit breaker 通知)。残: warn 観測→enforce 昇格、human_override の署名強制、realign 自動再計画                                                                                                                                                                           |
| AA-02 | DONE    | 2026-07-11 完了: driver/dispatchToPeer/writer fencing に加え、2-peer E2E(実 HTTP+HMAC、正常配送・復帰再配送・dead-letter・dedup)を実装。物理2プロセス実証のみ E3 パイロットへ                                                                                                                                                                                                                                                                                                                             |
| SA-02 | DONE    | 2026-07-12 再突合: 「残」とされた3点は実装済みだった — execution-bounds.ts(system-actuator 移行済み)/ SECURITY.md「Shell & ADF Execution Guardrails」節 / enforce は全経路で既定(warn 段階を経ず fail-closed、KYBERION_SHELL_POLICY 変数は不要と判断され不存在)。受入条件5点をコード+19テスト緑で確認。HMAC 署名は 2026-07-11 実装済み                                                                                                                                                                    |
| SA-05 | DONE    | 2026-07-12 完了: Task 2(dormant enforcement 2重バグ根治: YAML パーサ不全で全ポリシー無効 + `(?i)` 不発、発火文脈接続)/ Task 1(policy violation・actuator dispatch の kill-switch 供給。monitor 起動・graduated response・閾値外出しは実装済みを確認)/ Task 3.3(require_approval を requireApprovalForOp へ統一 — pending 承認リクエスト作成、承認後に再試行可)/ Task 4(統制サマリへ policies declared/loaded と anomalies 追加)。rapid-fire 閾値の実運用調整のみ trust-policy.json で運用対応             |
| OP-01 | DONE    | 2026-07-12 完了: 全経路計測・cost report・spend-guard(テナント override 含む)・operator packet 週次コスト表示・KPI 正本(docs/KPI_TRACKING.md)                                                                                                                                                                                                                                                                                                                                                             |
| AR-01 | PARTIAL | 2026-07-12: ループ全廃 + エンジン一本化 + Task 3/4 完了 + run_pipeline 意味論パリティ(budget 執行・step on_error)。golden 緑。残: run_pipeline ループの機械的委譲(意味論分岐は解消済み、性能/保守リファクタ扱い)                                                                                                                                                                                                                                                                                          |
| AR-02 | PARTIAL | 2026-07-12: describeOps を file/network/code/modeling/wisdom/browser へ横展開(wisdom decision-ops 48 op 含む)、registry/discovery を self-describe から生成し虚偽エントリを一掃(file symlink 等)。未知 op apply 既定は撤廃済み。残: ロングテール(非 pipeline 系)アクチュエータの self-describe と CAPABILITIES op 表の生成切替                                                                                                                                                                            |
| AO-02 | PARTIAL | 2026-07-11: scan/台帳/ルーブリック実装済み + §3.3 unit test + 適用フロー(propose 既定・--apply で backup→bump→install/typecheck/smoke→再スキャン→確定/ロールバック)。カナリアも 2026-07-11 接続済み(確定後に runDegradationWatch、台帳へ verdict 記録)→ AO-02 は全タスク完了。透過依存は 2026-07-11 に --override(pnpm.overrides 経由、明示オプトイン)で対応済み。日次スキャンは pipelines/dependency-vuln-scan.json の cron(JST 5:00)で配線済み・実走確認済み。Task 4 defer 再評価は 2026-07-11 実装済み |
| IL-01 | DONE    | 2026-07-12 完了: 全 seam 精査(mission 昇格2経路 / task_session / state 永続化 / フォールバック実装済み確認)+ 唯一のギャップだった pipeline 経路を実装(run_pipeline --context へ intent_goal 貫通、テスト3本)                                                                                                                                                                                                                                                                                              |
| IL-04 | DONE    | 2026-07-12 再突合で DONE: 突合エンジン・完了ゲート(task-session + mission finish)・全 shape クロージング(direct_reply 含む)・学習記録すべて実装済み、テスト21本緑                                                                                                                                                                                                                                                                                                                                         |

## 全計画一覧

### IP(コード品質)

| ID    | 状態    | 残作業(PARTIAL/TODO のみ)                                                                                                                                                                                      |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-01 | DONE    |                                                                                                                                                                                                                |
| IP-02 | DONE    |                                                                                                                                                                                                                |
| IP-03 | DONE    |                                                                                                                                                                                                                |
| IP-04 | DONE    | 2026-07-12 完了: 再監査で「参照ゼロ6本」は陳腐化(大半は manifest の contract_schema 正規参照)。真の未参照2本(ingestion/super-nerve)のみ削除、契約チェック緑。同名別契約の browser-pipeline は二重定義に非ず    |
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

| ID    | 状態    | 残作業                                                                                                                                                          |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO-01 | DONE    | (worker イベント連鎖のフェーズ駆動化は MO-02 側で実施。gate-pass 機械評価・entry_gate deferral・deliverable_quality check は MO-01 側で先行実装済み)            |
| MO-02 | PARTIAL | 残: フェーズ exit ゲートの warn→enforce 昇格、human_override 署名強制、realign 自動再計画(exit ゲート実行時評価は 2026-07-12 実装、他は再突合で実装済み確認)    |
| MO-03 | DONE    | 2026-07-12 完了: スキーマ/検証/循環検出/並列 wave/リースは実装済みを再突合確認、Task 2.3(scope 由来 dispatch 予算 + blocked(timeout) + 依存 blocked 連鎖)を実装 |
| MO-04 | DONE    |                                                                                                                                                                 |
| MO-05 | DONE    | (軽微: 集計スクリプト)                                                                                                                                          |
| MO-06 | DONE    |                                                                                                                                                                 |
| MO-07 | PARTIAL | tier 昇格連動の再実行、media draft→refine                                                                                                                       |

### DS(デザインシステム)

| ID    | 状態    | 残作業                                                                                                                                                                        |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DS-01 | PARTIAL | 生成ゲートの validate チェーン接続、operator-surface 残り約124 hex の変換                                                                                                     |
| DS-02 | PARTIAL | tier 隔離テスト(受入4)、DESIGN_SYSTEM.md テナント節                                                                                                                           |
| DS-03 | DONE    | pptx ea 日本語フォント、PDF サブセット埋め込み、日本語ゴールデン                                                                                                              |
| DS-04 | PARTIAL | 2026-07-11 突合: Task 1〜3 実装済み(compiler に 98 トークン、共有変数 54、テスト16件緑 — #490 の負検証は対象ディレクトリ誤り)。残: Task 4 テナント実写検証(DS-02 Task 3 依存) |
| DS-05 | DONE    | reduced-motion、コントラストゲート、light/dark トグル、ARIA                                                                                                                   |

### AA(エージェント間通信)

| ID    | 状態    | 残作業                                                                                                                                                                          |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AA-01 | DONE    |                                                                                                                                                                                 |
| AA-02 | DONE    | 2026-07-11 完了(2-peer E2E 含む。物理2プロセス実証は E3 パイロットへ)                                                                                                           |
| AA-03 | PARTIAL | 2026-07-12: 署名モジュール+鍵永続化(プロセス毎乱数廃止)・warn 段階(無署名/未知送信者の audit 記録、enforce で拒否)・運用文書(A2A_SIGNING.md)完了。残: 観測後の enforce 切替のみ |
| AA-04 | PARTIAL | 2026-07-11 突合: a2a-conversation-store.ts(rehydrate 含む)+ テスト実在・緑。残: inflight admission                                                                              |
| AA-05 | PARTIAL | mission flow コマンド、file 版 transport の quarantine 化                                                                                                                       |

### AR(アクチュエータリファクタリング/使いやすさ)

| ID    | 状態    | 残作業                                                                                                                                                                                    |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-01 | PARTIAL | 残: run_pipeline ループの機械的委譲のみ(意味論分岐は 2026-07-12 までに全解消: budget 執行・on_error・repair 統合・subprocess 廃止)                                                        |
| AR-02 | PARTIAL | 残: ロングテール(非 pipeline 系)アクチュエータの self-describe、CAPABILITIES op 表の生成切替(主要7アクチュエータの self-describe 生成は 2026-07-12 完了)                                  |
| AR-03 | PARTIAL | write_artifact/path 前倒し検証、notify/read_file/read_json/open_file 含む op_input_contracts、generate_op_registry/discovery 反映、browser/file/system の契約 coverage 検査、主要 op 検証 |
| AR-04 | PARTIAL | canonical op family 定義、browser alias 共通化、browser/system の正規化と警告                                                                                                             |
| AR-05 | PARTIAL | system file I/O の file-actuator forward、観察/変更・ドメイン境界の分割準備                                                                                                               |
| AR-06 | PARTIAL | teach message(shared helper で network/orchestrator/file/system へ展開)、skipped 明示化(run_pipeline 含む)、silent default 回帰検知、AR-01 集約                                           |

### SA(セキュリティ・監査)

| ID    | 状態    | 残作業                                                                                                                                                                                                                                                        |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SA-01 | DONE    | (残: audit-continuity の --warn-only → enforce)                                                                                                                                                                                                               |
| SA-02 | DONE    | 2026-07-12 再突合で DONE(execution-bounds / SECURITY.md / enforce 既定を実コード+テストで確認)                                                                                                                                                                |
| SA-03 | PARTIAL | 2026-07-11 突合: untrusted-content.ts + テスト実在(injection 検知含む、緑)。残: 汚染文脈ゲートの適用範囲精査                                                                                                                                                  |
| SA-04 | PARTIAL | 2026-07-11: warn 判定の永続化(audit chain へ記録 — 従来は in-memory のみで観測期間のデータが消失していた)+ pnpm egress:report(hostname 別集計と enforce 到達判定)。データ蓄積後に mode: enforce へ。残: tier 文脈付き egress ゲート、DNS リバインディング対策 |
| SA-05 | DONE    | 2026-07-12 全タスク完了(dormant enforcement 根治・kill-switch 供給・承認単一判定源・統制可視化)。rapid-fire 閾値調整は trust-policy.json の運用課題                                                                                                           |

### OP(運用・配布)

| ID    | 状態    | 残作業                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OP-01 | DONE    | spend-guard は 2026-07-11 実装(spend-policy.json、warn 既定/block で SpendCapExceededError、reasoning failover 前段に配線、日次 dedupe アラート)。usage 計測も 2026-07-11 に全経路接続(anthropic SDK は実 usage、gemini/codex CLI は estimated 概算)。cost report CLI も 2026-07-11 実装(pnpm cost:report、mission/model/日別、sdk 実コスト優先、estimated 分離表示 — 実履歴で確認)。週次サマリ接続も 2026-07-11 実装(weekly-review pipeline に cost_report --last-days 7 ステップ、実走確認)。operator packet 週次コスト表示(status report findings `weekly-cost` + metrics `weekly_cost_usd`)とテナント override(`tenant_overrides` 実効化、`KYBERION_TENANT`)は 2026-07-12 完了。KPI 正本 docs/KPI_TRACKING.md 新設 → **DONE** |
| OP-02 | DONE    | (残: 外部ボリューム定期運用の実績)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OP-03 | PARTIAL | bin フィールド+CLI、docker deploy サービス                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| OP-04 | PARTIAL | 残: RSS/restart 履歴の拡張と soak 実証のみ(劣化検知ループ・hourly cron・doctor rollup・healthz/status API・provider-health 永続化は 2026-07-11 実装: runtime state ファイル + TTL 自然回復 + reload API、vitest 下は隔離必須)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OP-05 | PARTIAL | 2026-07-11: env-registry(228変数)+ check:env-registry(validate/CI)+ env-validator + doctor 配線 + env.example/CONFIGURATION.md 生成。残: 棚卸しの継続キュレーション(documented=false 211件)、baseline-check 接続、集中ローダー移行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
| IL-01 | DONE    | 2026-07-12 完了(pipeline seam 実装で全 seam 貫通)                                                   |
| IL-02 | PARTIAL | 2026-07-11 突合: scripts/intent_trace.ts(pnpm intent:trace)実在。残: 相関 ID の全経路貫通精査       |
| IL-03 | PARTIAL | 2026-07-11 突合: intent-delta.ts(goalSimilarity 起点比較)+ テスト実在・緑。残: 実行中ドリフトゲート |
| IL-04 | DONE    | 2026-07-12 再突合で DONE(全受入条件が実装・テスト済みだった)                                        |
| IL-05 | PARTIAL | 2026-07-11 突合: pending-intent-store.ts + テスト実在・緑。残: 修正検知/completed 再オープンの精査  |

### ONB(初回オンボーディング)

| ID     | 状態    | 残作業                                                                                                                                                                                         |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONB-01 | DONE    |                                                                                                                                                                                                |
| ONB-02 | DONE    | (2026-07-05 完了: Node 24 統一・floor probe・Playwright 非致命警告・正本リンク統一)                                                                                                            |
| ONB-03 | PARTIAL | onboard:reset を追加。残: express、identity.example.json、vital-check の overlay 対応                                                                                                          |
| ONB-04 | PARTIAL | 2026-07-12 新設: `pnpm company:onboard`(dry-run / readiness / human owner / 初期 AI worker / 承認・予算境界 / first-work plan / CLI ドキュメント)実装済み。残: E2E-04 連結と受入条件の網羅突合 |

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

| ID    | 状態    | 残作業                                                                                                                                                                                                                                                                      |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CO-01 | PARTIAL | 2026-07-11 突合: company.ts と vision-resolver.ts は実装・テスト済み。残: getGoldenRule のテナント対応精査                                                                                                                                                                  |
| CO-02 | PARTIAL | 2026-07-11 突合: org-chart.ts + テスト実在・緑。残: カスタムロール作成フロー精査                                                                                                                                                                                            |
| CO-03 | PARTIAL | 2026-07-11 突合: financial-model.ts / okr-tracker.ts + テスト実在・緑。残: 経営判断への接続精査                                                                                                                                                                             |
| CO-04 | PARTIAL | 2026-07-11 突合: decision-rights.ts + テスト実在・緑。残: 承認ゲート統合精査                                                                                                                                                                                                |
| CO-05 | PARTIAL | 2026-07-11 突合: カタログに35テンプレート(採用/決算/調達/取締役会/資金調達を完備)+専用契約テスト緑(#490 の負検証はキー名誤り)。残: 受入条件の粒度精査                                                                                                                       |
| CO-06 | PARTIAL | 2026-07-12 新設・W0〜W5 実装済み(actor-neutral resource / human accountable owner / human-only approval / decision-rights human-final / usage ledger / workforce projection / acceptance→memory promotion guard)。残: 受入条件・成功指標(§8)との網羅突合と warning 期間運用 |
