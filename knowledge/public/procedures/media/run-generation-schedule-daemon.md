# Procedure: Run Generation Schedule Daemon

## 1. Goal
Run recurring `generation-schedule` checks as a background daemon so due schedules automatically submit `generation-job` records.

## 2. Dependencies
- **Actuator**: `daemon-actuator`
- **Runtime**: `run_generation_schedule_daemon.js`
- **Schedules**: registered under `active/shared/runtime/media-generation/schedules/`

## 3. Preparation
Register one or more schedules first.

```bash
pnpm generation:schedule --action register --input libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json
```

## 4. Daemon Registration
Example daemon input:

- [`register-generation-schedule-daemon.json`](/Users/famaoai/k/a/kyberion/libs/actuators/daemon-actuator/examples/register-generation-schedule-daemon.json)

Run:

```bash
node dist/libs/actuators/daemon-actuator/src/index.js \
  --action run-once \
  --nerve generation-schedule \
  --script dist/scripts/run_generation_schedule_daemon.js \
  --options '{"ephemeral":false}'
```

## 5. What It Does
- periodically invokes `run_generation_schedule --action tick`
- reconciles prior jobs
- submits due schedules as new `generation-job`
- updates `delivery_policy.latest_alias_path` when the previous job succeeded

## 6. Expected Output
- launchd registration under `~/Library/LaunchAgents/kyberion.generation-schedule.plist`
- logs under `active/shared/logs/generation-schedule.log`
- recurring updates under `active/shared/runtime/media-generation/`
