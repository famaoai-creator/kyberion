---
category: Added
---

- **Typed peer tasks** — `pnpm kyberion peer task propose|list|show|offered|accept|reject|resume|resend-result` lets one Kyberion peer ask another to run a task type the recipient offers in `knowledge/confidential/<tenant>/connections/peer-tasks.json` (a fixed pipeline or a `pnpm` script with fixed args, per allowed proposer). Receipt records a pending task only; the recipient operator's local `accept` runs it as a `source: peer` WorkItem, stores `report.json` / `output.log` as tenant artifacts (new tenant-bound role `peer_task_artifact_writer`) and returns sha256-pinned artifact references in a resendable `status` message. `peer_catalog_reader` additionally reads the task catalog and the tenant profile.
