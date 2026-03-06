---
title: Mission Conflict Avoidance Rules
category: Architecture
tags: [architecture, mission, conflict, avoidance]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Mission Conflict Avoidance Rules

To ensure stability when multiple missions are running in parallel, the following rules apply:

## 1. Resource Locking (Mutex)
- **Single Active Head**: Only one mission can have the status `active` per project workspace at any given time. Other missions must be `paused` or `planned`.
- **File Ownership**: If a mission modifies a shared library (e.g., `libs/core/`), it MUST declare this in `mission-state.json` under `context.associated_projects` or a new `locks` field.
- **Concurrent Writes**: Two missions cannot modify the same file. The `mission-controller` script will enforce this by checking active mission locks.

## 2. Context Isolation
- **Mission Folders**: All mission-specific logic, evidence, and temporary scripts MUST stay within `active/missions/{ID}/`.
- **Shared Space**: `active/shared/` is strictly for runtime feedback (`last_response.json`) and service coordination.

## 3. Priority Preemption
- **Urgent Stimuli**: A mission with `priority: 10` can automatically transition a `priority: 5` mission to `paused` if resource contention occurs.
- **Graceful Handover**: Before being preempted, the active mission MUST update its `mission-state.json` with the `next_step` to allow seamless resumption.
