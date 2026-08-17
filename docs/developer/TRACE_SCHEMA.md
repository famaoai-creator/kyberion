# Kyberion Trace Schema

> Generated from `libs/core/trace-schema.ts`; edit the schema source, not this file.

| Span kind  | Allowed parents     | Status error condition                       |
| ---------- | ------------------- | -------------------------------------------- |
| mission    | (root)              | mission failure or reconciliation rejection  |
| task       | mission             | task outcome is failed or rejected           |
| step       | task, mission       | typed operation returns a failure            |
| tool       | step, task, mission | tool call is blocked or failed               |
| compaction | task, mission       | summary or checkpoint persistence failed     |
| judge      | step, task          | judgment is invalid or has no matching route |
| hook       | tool, step, task    | hook fails or returns a terminal block       |
| gate       | tool, step, task    | gate denies or cannot evaluate safely        |

## mission

A durable mission lifecycle or run boundary.

### Attributes

| Phase | Name        | Type   | Cardinality | Sensitive | Description                   |
| ----- | ----------- | ------ | ----------- | --------- | ----------------------------- |
| start | mission_id  | string | low         | no        | Canonical mission identifier. |
| start | tenant_slug | string | low         | yes       | Tenant scope identifier.      |
| end   | status      | string | low         | no        | Mission terminal status.      |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## task

A mission task or delegated work item.

### Attributes

| Phase | Name    | Type   | Cardinality | Sensitive | Description                               |
| ----- | ------- | ------ | ----------- | --------- | ----------------------------------------- |
| start | task_id | string | low         | no        | Canonical task identifier.                |
| start | role    | string | low         | no        | Governed worker role.                     |
| end   | outcome | string | low         | no        | completed, rejected, failed, or deferred. |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## step

One typed pipeline or worker execution step.

### Attributes

| Phase | Name             | Type    | Cardinality | Sensitive | Description                               |
| ----- | ---------------- | ------- | ----------- | --------- | ----------------------------------------- |
| start | op               | string  | low         | no        | Canonical namespace:operation identifier. |
| start | step_id          | string  | low         | no        | Stable step identifier.                   |
| end   | duration_ms      | number  | low         | no        | Elapsed duration in milliseconds.         |
| end   | result_schema_ok | boolean | low         | no        | Whether the result passed its contract.   |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## tool

A model-visible tool call and its execution boundary.

### Attributes

| Phase | Name        | Type   | Cardinality | Sensitive | Description                       |
| ----- | ----------- | ------ | ----------- | --------- | --------------------------------- |
| start | tool_name   | string | low         | no        | Governed tool identifier.         |
| start | op          | string | low         | no        | Resolved operation identifier.    |
| end   | decision    | string | low         | no        | Preflight decision.               |
| end   | duration_ms | number | low         | no        | Elapsed duration in milliseconds. |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## compaction

Worker context compaction and checkpoint boundary.

### Attributes

| Phase | Name              | Type   | Cardinality | Sensitive | Description                     |
| ----- | ----------------- | ------ | ----------- | --------- | ------------------------------- |
| start | reason            | string | low         | no        | manual, threshold, or overflow. |
| start | tokens_before     | number | low         | no        | Estimated input tokens.         |
| end   | tokens_after      | number | low         | no        | Estimated retained tokens.      |
| end   | estimate_strategy | string | low         | no        | char or hybrid.                 |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## judge

A structured route or review judgment.

### Attributes

| Phase | Name           | Type   | Cardinality | Sensitive | Description                                  |
| ----- | -------------- | ------ | ----------- | --------- | -------------------------------------------- |
| start | schema_ref     | string | low         | no        | Governed structured-output schema reference. |
| start | judge_role     | string | low         | no        | Role/persona used for the judgment.          |
| end   | selected_route | string | low         | no        | Selected route or terminal outcome.          |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## hook

An extension lifecycle hook invocation.

### Attributes

| Phase | Name      | Type   | Cardinality | Sensitive | Description                     |
| ----- | --------- | ------ | ----------- | --------- | ------------------------------- |
| start | hook_name | string | low         | no        | Governed lifecycle hook name.   |
| end   | decision  | string | low         | no        | allow, block, ask, or continue. |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |

## gate

A policy, approval, scope, or egress gate.

### Attributes

| Phase | Name       | Type   | Cardinality | Sensitive | Description                   |
| ----- | ---------- | ------ | ----------- | --------- | ----------------------------- |
| start | gate_name  | string | low         | no        | Governed gate identifier.     |
| start | policy_ref | string | low         | no        | Policy or registry reference. |
| end   | decision   | string | low         | no        | allow, block, or ask.         |
| end   | reason     | string | high        | no        | Redacted gate explanation.    |

### Events

| Event    | Description                                |
| -------- | ------------------------------------------ |
| decision | A governed decision made during the span.  |
| error    | A normalized failure observed by the span. |
