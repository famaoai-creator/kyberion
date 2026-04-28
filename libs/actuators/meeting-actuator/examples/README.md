# Meeting Actuator Examples

Sample inputs for `meeting-actuator`. Consumed by the actuator's
schema test (`src/index.test.ts`) and by operators experimenting with
the abstraction.

- Cross-mission reusable pipelines live in `pipelines/` (e.g.
  `meeting-proxy-workflow.json`).
- Actuator-specific examples / fixtures live here.

Each example must validate against
[`schemas/meeting-action.schema.json`](../../../../schemas/meeting-action.schema.json).
The schema test fails CI if any example here drifts.

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
