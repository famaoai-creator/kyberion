/**
 * Shared append-only JSONL entry-ledger mechanics.
 *
 * One concept — an append-only ledger of schema-validated entries — used to
 * be rebuilt per domain (ingest asset ledger, inboxes, promotion queues,
 * provenance ledgers). This factory owns the mechanics that are always the
 * same: ensure the parent directory, reject non-regular files, append one
 * validated line, and read lines back tolerating corrupt rows.
 *
 * Domain semantics stay outside: validation rules, dedupe keys, state
 * transitions, tenant isolation and compaction policy are caller concerns.
 */

import * as path from 'node:path';
import { appendJsonLine } from './foundation/json.js';
import { streamJsonLines } from './jsonl-read.js';
import { safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';

export interface EntryLedgerOptions {
  /** How to handle corrupt lines on read. Default 'skip'. */
  onMalformed?: 'skip' | 'throw';
  /** Require the ledger file to be a regular file (symlink rejected). */
  requireRegularFile?: boolean;
}

export interface EntryLedger<T> {
  readonly path: string;
  /** Append one entry. The caller validates/shapes it first. */
  append(entry: T): T;
  /** Read all entries in append order; optional per-line map may drop rows by returning null. */
  readAll(map?: (value: unknown, lineNumber: number) => T | null): T[];
  exists(): boolean;
}

function assertRegularFile(filePath: string): void {
  if (!safeExistsSync(filePath)) return;
  const stat = safeLstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`[ENTRY_LEDGER] ledger must be a regular file: ${filePath}`);
  }
}

export function createEntryLedger<T>(
  ledgerPath: string,
  options: EntryLedgerOptions = {}
): EntryLedger<T> {
  const { onMalformed = 'skip', requireRegularFile = true } = options;

  const ensure = (): void => {
    if (requireRegularFile) assertRegularFile(ledgerPath);
  };

  return {
    path: ledgerPath,
    append(entry: T): T {
      ensure();
      safeMkdir(path.dirname(ledgerPath), { recursive: true });
      appendJsonLine(ledgerPath, entry);
      return entry;
    },
    readAll(map?: (value: unknown, lineNumber: number) => T | null): T[] {
      if (!safeExistsSync(ledgerPath)) return [];
      ensure();
      const entries: T[] = [];
      let lineNumber = 0;
      for (const value of streamJsonLines<unknown>(ledgerPath, { onMalformed })) {
        lineNumber += 1;
        try {
          const entry = map ? map(value, lineNumber) : (value as T | null);
          if (entry !== null) entries.push(entry);
        } catch (error) {
          // readJsonLines parity: with onMalformed 'skip', a row rejected by the
          // caller's map (e.g. schema validate) is dropped like a corrupt line.
          if (onMalformed !== 'skip') throw error;
        }
      }
      return entries;
    },
    exists(): boolean {
      return safeExistsSync(ledgerPath);
    },
  };
}
