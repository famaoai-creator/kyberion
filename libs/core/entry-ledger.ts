/**
 * Re-export — implementation lives in `@agent/kernel`.
 *
 * Side-effect: install the governed default `local-fs` backend so core
 * consumers of `createEntryLedger` keep getting secure-io persistence without
 * an explicit local-storage import. Kernel's entry-ledger does not auto-install.
 */
export * from '@agent/kernel/entry-ledger';
import './storage/local-storage-backend.js';
