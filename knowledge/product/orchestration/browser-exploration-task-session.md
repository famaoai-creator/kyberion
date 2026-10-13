---
title: Browser exploration to reviewed pipeline task session
tags: [browser, task-session, pipeline, orchestration]
last_updated: 2026-10-13
---

# Browser exploration and pipeline promotion

Use a task session to carry a browser investigation from model-guided discovery to a replayable pipeline. The task session owns progress and evidence; the browser actuator owns browser execution.

## Flow

1. Call `browser-actuator` `computer_interaction` with `action.type: "llm_assist"`, the task goal, an explicit HTTPS `allowed_origins` list, and bounded `max_actions`.
2. The actuator creates a browser task session and returns its `task_session_id`. The session starts in `executing` and keeps the browser runtime `session_id` separate.
3. The local reasoning backend chooses one safe browser action per fresh DOM snapshot. The actuator stores a bounded progress summary and, when available, the unapproved `pipeline_candidate` in the task session. A completed exploration moves to `verifying`; a partial or interrupted exploration moves to `paused`.
4. Review the candidate steps, selectors, origins, and browser options. The candidate is a draft; model-generated steps do not run automatically as a pipeline.
5. Replay the reviewed `pipeline_candidate.steps` through the browser actuator's normal `action: "pipeline"` contract, passing the candidate options, a new `session_id`, and the returned `task_session_id`.
6. The actuator accepts the replay only when the steps and allowed origins match the stored candidate and the browser session is fresh. A successful replay records the verification evidence and completes the task session.

## Replay contract

```ts
{
  "action": "pipeline",
  "session_id": "browser-replay-fresh-session",
  "task_session_id": "<task_session_id from llm_assist>",
  "options": candidate.options,
  "steps": candidate.steps
}
```

Copy the actual `options` and `steps` objects from the returned candidate. Do not reuse the exploratory browser session. The actuator rejects changed steps, changed origins, and replay in the original session; edit the candidate only by running a new exploration and reviewing its output.

The workflow does not purchase items, authenticate, submit personal data, or promote a draft automatically. Those actions remain outside the browser assistant's allowed action set.
