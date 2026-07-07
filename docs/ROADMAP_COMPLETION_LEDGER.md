# Roadmap Completion Ledger

> 目的: 散在している roadmap のうち、**実装完了済みの項目だけ** を横断で見える化する。
> 原文の roadmap が権威であり、この台帳は「完了済みのものを探しやすくするための索引」である。
> 完了表記が変わったら、まず原文を更新し、その後この台帳を追従させる。

## 1. Completed by roadmap

### PRODUCTIZATION_ROADMAP

完了済み:

- `A-1` ポジショニング / WHY 文書
- `A-3` ワンライナー起動 + on-demand pull
- `A-4` preflight doctor 強化
- `A-5` Voice first win 実装
- `A-7` エラー分類器
- `A-8` Privacy / Telemetry スタンス明示
- `A-9` LICENSE / 第三者依存棚卸し
- `C-2` 1 時間で読める入口 doc

部分完了 / 継続:

- `A-2` README 全面書き直し

未完了の主なまとまり:

- `A-6` デモ素材 3 本
- `B-*` 信頼性・Trace・観測・回復
- `C-*` contributor 基盤
- `D-*` FDE / 導入支援

### ROADMAP_ENGINE_REFINEMENT

完了済み:

- Phase 1: `1.1` 〜 `1.6`
- Phase 2: `2.1` 〜 `2.4`
- Phase 3: `3.1`, `3.5`, `3.7`
- Phase 4: `4.1` 〜 `4.6`
- Phase 5: `5.1`, `5.2`
- Phase 6: `6.1` 〜 `6.4`

未完了の主なまとまり:

- Phase 1: `1.7`
- Phase 2: `2.5` 〜 `2.7`
- Phase 3: `3.2` 〜 `3.4`, `3.6`
- Phase 4: `4.7`
- Phase 5: `5.3` 〜 `5.8`
- Phase 6: `6.5`, `6.6`

### TASK_SCENARIO_ROADMAP

完了済み:

- `daily-email-triage` の scenario + workflow + CLI profile path
- `meeting-action-items` の scenario + workflow MVP
- `meeting-to-proposal-pptx` の TaskScenario contract
- `weekly-executive-digest` の scenario + workflow MVP

継続:

- `sales-inbound-response` の workflow profile 化
- `TaskScenario` schema / example / CLI 入口の残タスク

### service-integration-plan

完了済み:

- ComfyUI の connection + presets + fragments

継続:

- Whisper (STT) runtime validation
- Voice (TTS) runtime validation
- Meeting-Browser-Driver の dynamic path resolution
- `baseline-check` と self-healing prompts

### improvement-plans-2026-07

完了済み:

- [x] **SA-01**: Audit Chain Integrity (`SA-01_AUDIT_CHAIN_INTEGRITY.ja.md`)
- [x] **AO-03**: Daemon Supervision & Escalation (`AO-03_DAEMON_SUPERVISION_ESCALATION.ja.md`)
- [x] **ONB-01**: Reasoning Backend Onboarding (`ONB-01_REASONING_BACKEND_ONBOARDING.ja.md`)
- [x] **KM-04**: Knowledge Store Hygiene (`KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md`)
- [x] **IP-04**: Dead Reference Cleanup (`IP-04_DEAD_REFERENCE_CLEANUP.ja.md`)
- [x] **IP-06**: Workspace Consistency (`IP-06_WORKSPACE_CONSISTENCY.ja.md`)
- [x] **IP-13**: Model ID Centralization (`IP-13_MODEL_ID_CENTRALIZATION.ja.md`)
- [x] **AC-03**: Deploy CI/CD Capability (`AC-03_DEPLOY_CICD_CAPABILITY.ja.md`)
- [x] **MO-04**: Worker Context Economy (`MO-04_WORKER_CONTEXT_ECONOMY.ja.md`)
- [x] **MO-05**: Task Model Effort Routing (`MO-05_MODEL_EFFORT_ROUTING.ja.md`)
- [x] **IP-01**: ESLint Governance Enforcement (`IP-01_ESLINT_GOVERNANCE_ENFORCEMENT.ja.md`)
- [x] **IP-02**: Native Engine secure-io Migration (`IP-02_NATIVE_ENGINE_SECURE_IO.ja.md`) — 残余の child_process disable は IP-08 スコープ
- [x] **AA-01**: Agent Runtime Resilience (`AA-01_RUNTIME_RESILIENCE.ja.md`)
- [x] **UX-06**: Onboarding/Dashboard Integrity (`UX-06_ONBOARDING_DASHBOARD_INTEGRITY.ja.md`)
- [x] **OP-02**: Backup & Recovery (`OP-02_BACKUP_RECOVERY.ja.md`) — 別ホストでの定期運用実績のみ未取得
- [x] **DS-01**: Canonical Design Tokens (`DS-01_CANONICAL_DESIGN_TOKENS.ja.md`)
- [x] **IP-03**: CI Test Gates (`IP-03_CI_TEST_GATES.ja.md`) — integration シャード必須化済み
- [x] **KM-01**: Volatile Memory Activation (`KM-01_VOLATILE_MEMORY_ACTIVATION.ja.md`) — Task 4(1週間試行評価)のみ日程待ち
- [x] **UX-01**: Error Presentation (`UX-01_ERROR_PRESENTATION.ja.md`)
- [x] **AC-01**: Capability Truthfulness (`AC-01_CAPABILITY_TRUTHFULNESS.ja.md`) — services 到達性プローブは AC-04/AC-06 へ
- [x] **MO-01**: Mission Type Effectiveness (`MO-01_MISSION_TYPE_EFFECTIVENESS.ja.md`) — worker のフェーズ駆動差し替えは MO-02 へ委譲
- [x] **ONB-02**: Canonical Coldstart (`ONB-02_CANONICAL_COLDSTART.ja.md`) — クリーンクローン実走検証のみ未実施
- [x] **SA-02**: ADF/Shell Guardrails (`SA-02_ADF_SHELL_GUARDRAILS.ja.md`) — 承認ルーティングの対話接続は SA-05 側で
- [x] **IL-01**: Goal Threading (`IL-01_GOAL_THREADING.ja.md`) — E2E 実走検証は IL-04 と併せて
- [x] **IP-07**: Critical Path Tests (`IP-07_CRITICAL_PATH_TESTS.ja.md`) — orchestrator 追加特性化は IP-10 前に
- [x] **AA-02**: Mesh Hub Delivery Driver (`AA-02_MESH_HUB_DELIVERY_DRIVER.ja.md`) — 2プロセス実HTTP E2E は E3 パイロットで
- [x] **E2E-02**: Creative Suite (`E2E-02_CREATIVE_SUITE.ja.md`) — 単一 resolver・VDS-07・style pack 注入・campaign-suite。歌詞字幕同期のみ残余
- [x] **E2E-06**: Customer Dialogue (`E2E-06_CUSTOMER_DIALOGUE.ja.md`) — Task 1〜8 完了(見積/契約生成+レビューゲート・impact_analysis・won→SDLC handoff・distill 還流)。帳票整形(xlsx/pdf)と intake pipeline のみ残余(原文 §7)
- [x] **E2E-03**: Agent Collaboration (`E2E-03_AGENT_COLLABORATION.ja.md`) — 全 Task 完了(best-of-2+judge、code_change PR 協調を追加)
- [x] **E2E-04**: Operator Interface (`E2E-04_OPERATOR_INTERFACE.ja.md`) — Task 2(notifyOperator 通知ルーティング)を追加実装し発火点(承認・質問・完了/失敗・inbox)を配線。CLI 統一(Task 6)は残余
- [x] **E2E-05**: App Lifecycle (`E2E-05_APP_LIFECYCLE.ja.md`) — Task 1〜7 完了(app:preflight・build-actuator・scaffold・sdlc-cycle・device compiler・mobile-beta)。実機実走記録のみ未取得(原文 §7)

## 2. 使い方

- 新しく完了した項目が出たら、まず該当 roadmap の原文を `done` / `✅` に更新する。
- その後、この台帳に 1 行追記して、完了済みを横断検索しやすくする。
- 完了済みの詳細設計や受入条件は、各 roadmap の原文を参照する。
