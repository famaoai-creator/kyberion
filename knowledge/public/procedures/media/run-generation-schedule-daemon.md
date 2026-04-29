# Procedure: Run Generation Schedule Daemon

## 1. Goal
Run recurring `generation-schedule` checks as a background daemon so due schedules automatically submit `generation-job` records.

> Status: `daemon-actuator` is retired. Use `surface-runtime` instead of launchd registration.

## 2. Dependencies
- **Runtime**: `surface-runtime`
- **Runtime**: `run_generation_schedule_daemon.js`
- **Schedules**: registered under `active/shared/runtime/media-generation/schedules/`

## 3. Preparation
Register one or more schedules first.

```bash
pnpm generation:schedule --action register --input libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json
```

## 4. Surface Declaration
Example surface record:

- [`generation-schedule-surface.json`](../../governance/pipelines/generation-schedule-surface.json)

Run:

```bash
pnpm surfaces:reconcile
```

## 5. What It Does
- periodically invokes `run_generation_schedule --action tick`
- reconciles prior jobs
- submits due schedules as new `generation-job`
- updates `delivery_policy.latest_alias_path` when the previous job succeeded

## 6. Expected Output
- runtime ownership under `active/shared/runtime/surfaces/state.json`
- logs under `active/shared/logs/generation-schedule.log`
- recurring updates under `active/shared/runtime/media-generation/`
