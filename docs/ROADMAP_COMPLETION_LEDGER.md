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

## 2. 使い方

- 新しく完了した項目が出たら、まず該当 roadmap の原文を `done` / `✅` に更新する。
- その後、この台帳に 1 行追記して、完了済みを横断検索しやすくする。
- 完了済みの詳細設計や受入条件は、各 roadmap の原文を参照する。
