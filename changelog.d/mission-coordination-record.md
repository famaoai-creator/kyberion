---
category: Changed
---

- **Mission coordination bus is now a record** — `MissionCoordinationBus` (inbox, acknowledgements, in-memory cache) had no production reader: workers get tasks through the agent execution port. It is now `recordMissionCoordinationMessage` in `libs/core/mission/mission-coordination-record.ts` (subpath `@agent/core/mission/mission-coordination-record`), a write-only owner-to-worker record. The on-disk `coordination/bus.jsonl` and its row format are unchanged; old ledgers still parse, and their acknowledgement rows are skipped. Removed from `@agent/core`: the subpath `@agent/core/mission/mission-coordination-bus` and the exports `MissionCoordinationBus`, `missionCoordinationBus`, `MissionCoordinationMessage`, `parseMissionCoordinationMessage` and `parseMissionCoordinationEvent`, with the inbox, acknowledge and list methods and the `ack` event type (see `retired/README.md`).
