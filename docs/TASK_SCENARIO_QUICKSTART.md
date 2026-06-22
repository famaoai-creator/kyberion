# TaskScenario Quickstart

TaskScenario gives you a task-first way to try one repeatable workflow without reading implementation details first.

The first run is intentionally simple:

1. List the available tasks.
2. Initialize one saved profile with answers.
3. Run a dry-run preview and review the plan.

## Copy-paste start

```bash
pnpm task:list
pnpm task:init daily-email-triage --answers-json '{"重要メールとして扱う送信元や条件は何か":"顧客、役員、採用候補者からのメール","返信下書きに含めてよいカテゴリや情報の範囲はどこまでか":"日程調整と受領確認のみ","送信前に人間承認が必要になる条件は何か":"外部送信は常に承認","返信トーンはどの程度まで自動化してよいか":"丁寧で簡潔"}'
pnpm task:run daily-email-triage --dry-run
```

## What you should see

### Profile created

```text
Profile created: knowledge/personal/task-profiles/daily-email-triage.json
```

### Dry-run plan

```text
TaskScenario: daily-email-triage
Status: dry-run only; no external side effects
```

### Approval boundary

```text
Approval required before: external send
```

### Expected artifacts

```text
- profile: knowledge/personal/task-profiles/daily-email-triage.json
- dry-run plan: active/shared/tmp/taskscenario/daily-email-triage-plan.json
```

## Safety note

- `task:run` is currently dry-run only.
- no external send happens automatically.
- You can inspect the plan before anything leaves the machine.

## What to do next

1. Edit the profile if the defaults do not match your process.
2. Inspect the expected artifacts before treating the preview as final.
3. Choose a task scenario and repeat the flow with another task ID.

## Related docs

- [TaskScenario Roadmap](./TASK_SCENARIO_ROADMAP.md)
- [Scenario Catalog](./SCENARIO_CATALOG.md)
