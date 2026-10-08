# Meeting Actuator Examples

Sample inputs for `meeting-actuator`. Consumed by the actuator's
schema test (`src/index.test.ts`) and by operators experimenting with
the abstraction.

- Cross-mission reusable pipelines live in `pipelines/` (e.g.
  `meeting-proxy-workflow.json`).
- Actuator-specific examples / fixtures live here.

Each example must validate against
[`knowledge/product/schemas/meeting-action.schema.json`](../../../../knowledge/product/schemas/meeting-action.schema.json).
The schema test fails CI if any example here drifts.

The actuator accepts three envelopes: legacy `{ action, params }`
(session transport), catalog-style single-op `{ op, params }` (all 19
ops, including intelligence / target / dialogue ops such as
`resolve_next_target` and `extract_action_items`), and
`{ action: "pipeline", steps: [...] }`. Session transport lives in
`src/meeting-session.ts`; intelligence / target / dialogue dispatch in
`src/meeting-op-dispatch.ts`.

## Example: join a Zoom meeting

```bash
node dist/libs/actuators/meeting-actuator/src/index.js \
  --input libs/actuators/meeting-actuator/examples/join-zoom.json
```

## Example: leave the active meeting

```bash
node dist/libs/actuators/meeting-actuator/src/index.js \
  --input libs/actuators/meeting-actuator/examples/leave.json
```
