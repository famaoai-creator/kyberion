---
title: Full Graph Handoff and Recovery Flow
tags: [orchestration, graph, mission, handoff, reviewer, recovery, codex]
last_updated: 2026-08-01
role_affinity: [orchestrator, planner, researcher, reviewer, mission_controller]
phase_affinity: [execution, verification, review, retrospective]
---

# Full Graph Handoff and Recovery Flow

## 目的

この知識は、`researcher → planner → reviewer` のような依存グラフを、worker loop の再スキャンに依存せず実行し、途中の runtime readiness・transport timeout・review gate の失敗から復旧するための標準手順である。

対象は mission の `NEXT_TASKS.json` と graph-run journal で管理される task graph であり、mission-local の一時的な手順ではない。再実行時も、task result・handoff・review receipt・lifecycle evidence を読み戻して同じ判断を再現できる状態を作る。

## 正準の責務分離

| role           | 責務                                                                                            | やってはいけないこと                                      |
| -------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `researcher`   | source-indexed evidence、根拠、未確実性、bounded handoff を作る                                 | repository code の変更、未確認情報の補完                  |
| `planner`      | predecessor handoff を消費し、分解・順序・契約・実行境界を決める                                | predecessor の根拠を捨てた無制限な実装判断                |
| `orchestrator` | frontier、dependency readiness、retry/rework、provider degradation、owner escalation を管理する | task owner の成果物を直接書き換える                       |
| `reviewer`     | implementer と独立に artifact を反証し、hash-bound receipt と verdict を残す                    | suggestion だけで block する、実装担当と同じ actor を選ぶ |

agent manifest、agent profile、team-role index、mission team assignment は同じ provider/model/capability 契約を指していなければならない。profile だけ追加して manifest を追加しない場合、A2A bridge は安全に spawn を拒否する。

## 標準フロー

```text
intent / goal
  ↓
mission + team template
  ↓
NEXT_TASKS.json
  ↓  (control edge + data edge)
graph frontier
  ↓
researcher task_result
  ↓  (namespace handoff)
planner task_result
  ↓  (artifact review gate)
independent reviewer + receipt
  ↓
verification → distillation → completed
```

1. `AGENTS.md` を読み、`pnpm pipeline --input pipelines/baseline-check.json` で baseline を取得する。
2. mission/team template で role assignment を確定する。低コストの bounded task は `openai:gpt-5.6-luna` など、assignment に明示した model hint を使う。
3. graph scheduler は planned/rework task を一つの frontier に登録する。`dependencies` は control edge、`mission-task:<id>` は data edge として handoff を表現する。
4. predecessor が完了したら、`task_result` と outcome を successor の context pack に namespace 付きで渡す。worker loop の次の全体再スキャンを待たない。
5. 各 task の結果は schema、artifact、verification、gaps、needs、provenance を確認してから node state に記録する。
6. reviewer task は `review_target` に依存し、implementer agent と独立した reviewer を選ぶ。成果物の hash と reviewer identity を artifact review receipt に固定する。
7. graph journal の最終条件は、全 task が terminal state であり、`graph_finished.remaining_planned_count = 0` であること。`graph_finished` だけでは成功を意味しないため、各 node の `task_result` / `node_state` と receipt を併読する。
8. mission-level の完了条件は graph task の完了とは別に、mission controller の `verify` → `distill` で閉じる。mission state には `verification`、`distillation`、`completed_at` を正準 evidence として保存する。

## 失敗時の分類と復旧

### 1. graph が空振りし、task が planned のまま

prewarm 成功は dispatch 成功を意味しない。まず graph journal に `task_result` / `node_state` があるか確認する。なければ、同じ invocation を無変更で再試行せず、次を確認する。

- `NEXT_TASKS.json` の status、dependency、assigned role
- team composition と assignment の provider/model
- agent manifest の存在と capability
- `a2a_message_routed`、`agent_runtime_ensure_completed`、`agent_runtime_ask_completed`

### 2. `Agent ... not found or not ready`

daemon-backed runtime を現在プロセスの in-process registry から探してはいけない。A2A bridge は daemon の ensure/ask を同じ supervisor 経路で利用し、manifest verified の runtime を再 ensure する。provider/model が assignment と一致しない cached runtime は再利用しない。

### 3. 長い task が固定 transport timeout で切れる

runtime の `timeoutMs` だけを延長してはいけない。supervisor socket の transport timeout は task budget より長くし、少なくとも短い transport timeout が in-process fallback を誘発しないようにする。標準実装は `task timeout + 5秒` とする。

### 4. reviewer が mission completion を誤って block する

reviewer は task artifact と mission lifecycle の両方を読む。`mission-state.json` の status だけでなく、`verification.status`、`distillation.status`、`completed_at`、および history の `VERIFY` / `DISTILL` を確認する。履歴だけに依存する旧 state は、mission controller 管理下で canonical metadata を補正してから再レビューする。

### 5. rework / blocked が発生した

upstream の completed result は保持し、影響を受ける node だけを rework する。reviewer は implementer の成果物を再生成せず、具体的な finding を `must_fix` / `should_fix` / `nit` に分類する。rework 上限に達した場合は owner escalation と mission pause に進み、無制限 retry はしない。

## 完了判定チェックリスト

- [ ] `baseline-check` が完了している
- [ ] role boundary と provider/model assignment が manifest/profile/index で一致している
- [ ] graph journal に `graph_started`、各 node の `node_state`、`graph_finished` がある
- [ ] source → planner の predecessor handoff が task result に現れている
- [ ] reviewer が implementer と独立している
- [ ] artifact review receipt が対象 hash と reviewer identity を含む
- [ ] reviewer の `result_schema_ok` が true、未解決 `needs` / blocking `gaps` がない
- [ ] `graph_finished.remaining_planned_count = 0`
- [ ] mission controller の `verify` → `distill` が完了し、mission state に canonical lifecycle evidence がある
- [ ] focused tests、core build、governance check、`git diff --check` が通っている

## 再利用する証跡

実行ごとに次を mission-local に残す。

- `coordination/graph-run-*.jsonl`
- `coordination/context-packs/` と `coordination/context-rollups/`
- `evidence/reviews/*.json`
- `NEXT_TASKS.json` の terminal task result
- `mission-state.json` の verification/distillation metadata
- distillation output と mission checkpoint

これらを揃えることで、「runtime が起動した」ではなく「依存 handoff と独立 review を含む full graph が完了した」と判定できる。
