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

## 1. Resource Locking vs Mission Leases
- **Mission Ownership**: A mission has one owner agent at a time. Ownership is represented by a mission lease, not by an implicit global active head.
- **File Ownership**: If a mission modifies a shared library (e.g., `libs/core/`), it MUST declare intended write scope and task ownership in mission-local coordination artifacts.
- **Concurrent Writes**: Two active task leases cannot overlap on the same write scope. Short-lived file mutation still uses resource locks, but authority comes from leases.

## 2. Context Isolation
- **Mission Folders**: All mission-specific logic, evidence, and coordination MUST stay within `active/missions/{tier}/{ID}/`.
- **Mission-Local Coordination**: `coordination/tasks`, `coordination/claims`, `coordination/handoffs`, `coordination/reviews`, and `coordination/events` are the canonical collaboration surfaces for that mission.
- **Shared Space**: `active/shared/` is reserved for global discovery, runtime coordination, mailboxes, leases, and observability summaries.

## 3. Priority Preemption
- **Urgent Stimuli**: A mission with materially higher priority may force lease renegotiation if resource contention occurs.
- **Graceful Handover**: Before preemption, the owner agent MUST emit a mission event and handoff artifact describing next step, held leases, and open tasks so another agent can resume safely.

## 4. Collaboration Rule
- **Single-Owner, Multi-Worker**: Mission state changes are performed by one owner agent. Worker agents may execute delegated tasks concurrently only through explicit task contracts and leases.
