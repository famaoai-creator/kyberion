---
category: Security
---

- **`audit:verify` requires keyed chains** — every unkeyed (`sha256`) entry in the audit chain and the ledgers is now an `unkeyed_entry` finding, so a chain rewritten without the key from genesis no longer verifies. `--allow-legacy-unkeyed` (op param `allow_legacy_unkeyed`) accepts an unkeyed prefix written before HMAC hardening, but never an unkeyed entry after a keyed one (`chain_downgrade`) and never in a tenant ledger partition. Each chain reports its unkeyed count. In-process verifiers (`verifyIntegrity`, `verifyScopedIntegrity`) flag downgrades.
- **Audit-chain verification no longer drops unreadable files** — an unparseable line is a `<file>:line:N:invalid_record` finding instead of silently emptying its file, and a `--since` window continues from the last entry before it (link and keyed state), so a rewritten window cannot restart from the boundary hash.
- **Secret actuator keeps account names out of the system ledger** — `CONFIG_CHANGE` records always carry `changed_key_count`; the account name is recorded only into the evidence ledger of the ephemeral mission the actuator itself started, never when the mission failed to start or `MISSION_ID` is inherited (it may name an archived mission).
- **Backup manifest construction is a tested function** — `buildBackupManifest` covers `tenant_runtime_partitions` (tenant scope only), `chain_key_id` (only with a key, never the key), and mission bundle pairing, round-tripped through the restore parser.
