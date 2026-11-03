// Step-1 distributed-runtime acceptance: the storage-backend seam resolves the
// governed default (local-fs), explicit selectors win, and entry-ledger runs
// hermetically on the memory backend — append, streaming read, malformed-line
// policy and regular-file enforcement all without touching the filesystem.
import { describe, expect, it } from 'vitest';
import { createEntryLedger } from '../entry-ledger.js';
import {
  LOCAL_STORAGE_BACKEND_ID,
  getStorageBackend,
  resolveStorageBackend,
} from './storage-backend.js';
import './local-storage-backend.js';
import { MEMORY_STORAGE_BACKEND_ID, createMemoryStorageBackend } from './memory-storage-backend.js';

describe('storage-backend seam', () => {
  it('resolves the governed default to local-fs', () => {
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
  });

  it('resolves an explicit selector over the default', () => {
    expect(resolveStorageBackend(MEMORY_STORAGE_BACKEND_ID).id).toBe(MEMORY_STORAGE_BACKEND_ID);
  });

  it('throws for an unknown selector', () => {
    expect(() => resolveStorageBackend('no-such-backend')).toThrow(
      /unknown backend 'no-such-backend'/
    );
  });

  it('keeps memory out of the default chain (registered but never auto-selected)', () => {
    expect(getStorageBackend(MEMORY_STORAGE_BACKEND_ID)).toBeDefined();
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
  });
});

describe('entry-ledger on a memory backend', () => {
  it('appends and reads entries back in order', () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger<{ v: number }>('/state/test/ledger.jsonl', { backend });
    expect(ledger.exists()).toBe(false);
    ledger.append({ v: 1 });
    ledger.append({ v: 2 });
    expect(ledger.exists()).toBe(true);
    expect(ledger.readAll()).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('skips malformed lines by default and throws on request', () => {
    const backend = createMemoryStorageBackend();
    const ledgerPath = '/state/test/mixed.jsonl';
    backend.append(ledgerPath, '{"ok":1}\nnot-json\n{"ok":2}\n');
    const lenient = createEntryLedger<{ ok: number }>(ledgerPath, { backend });
    expect(lenient.readAll()).toEqual([{ ok: 1 }, { ok: 2 }]);
    const strict = createEntryLedger<{ ok: number }>(ledgerPath, {
      backend,
      onMalformed: 'throw',
    });
    expect(() => strict.readAll()).toThrow();
  });

  it('drops rows rejected by the caller map under skip policy', () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger<{ v: number }>('/state/test/mapped.jsonl', { backend });
    ledger.append({ v: 1 });
    ledger.append({ v: 2 });
    const seen = ledger.readAll((value) => {
      const v = (value as { v: number }).v;
      if (v === 1) throw new Error('reject');
      return v === 2 ? { v } : null;
    });
    expect(seen).toEqual([{ v: 2 }]);
  });

  it('rejects a non-regular ledger path', () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger('/state/test/dir-ledger', { backend });
    backend.mkdir('/state/test/dir-ledger');
    expect(() => ledger.append({ v: 1 })).toThrow(/must be a regular file/);
  });

  it('lists directory children', () => {
    const backend = createMemoryStorageBackend();
    backend.append('/state/test/a.jsonl', '1\n');
    backend.append('/state/test/nested/b.jsonl', '2\n');
    expect(backend.list('/state/test')).toEqual(['a.jsonl', 'nested']);
  });
});
