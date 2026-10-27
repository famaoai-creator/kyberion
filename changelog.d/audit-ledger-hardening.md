---
category: Security
---

- **`audit:verify` rejects keyed-to-unkeyed chain downgrades** — unkeyed (`sha256`) entries are accepted only as a legacy prefix: an unkeyed entry after a keyed one is a `chain_downgrade` finding in the audit chain and every ledger, tenant ledger partitions accept keyed entries only (`unkeyed_entry`), each chain reports its unkeyed count, and `--require-keyed` (op param `require_keyed`) makes every unkeyed entry a finding.
- **Secret actuator keeps account names out of the system ledger** — when its ephemeral mission cannot be created, the `CONFIG_CHANGE` record carries `changed_key_count` instead of `changed_keys`.
- **Backup manifest construction is a tested function** — `buildBackupManifest` covers `tenant_runtime_partitions` (tenant scope only), `chain_key_id` (only with a key, never the key), and mission bundle pairing, round-tripped through the restore parser.
