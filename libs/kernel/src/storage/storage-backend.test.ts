// Step-1 distributed-runtime acceptance: the storage-backend seam resolves the
// default chain (local-fs), explicit selectors win, and entry-ledger runs
// hermetically on the memory backend — append, streaming read, malformed-line
// policy and regular-file enforcement all without touching the filesystem.
// Async contract: object-storage stub proves awaited durability.
//
// local-fs production adapter lives in @agent/core (secure-io). This suite
// installs a minimal local-fs stand-in so default-chain assertions stay in
// kernel without depending on core.
import { describe, expect, it } from 'vitest';
import { createEntryLedger } from '../entry-ledger.js';
import {
  LOCAL_STORAGE_BACKEND_ID,
  getStorageBackend,
  registerStorageBackend,
  resolveStorageBackend,
  setStorageBackendDefaultOrderResolver,
  toAsyncStorageBackend,
  type SyncStorageBackend,
} from './storage-backend.js';
import { MEMORY_STORAGE_BACKEND_ID, createMemoryStorageBackend } from './memory-storage-backend.js';
import {
  OBJECT_STORAGE_BACKEND_STUB_ID,
  createObjectStorageBackendStub,
} from './object-storage-backend.stub.js';

const localFsStub: SyncStorageBackend = {
  id: LOCAL_STORAGE_BACKEND_ID,
  exists: () => false,
  stat: () => null,
  mkdir: () => undefined,
  append: () => undefined,
  *readLines() {
    /* empty */
  },
  list: () => [],
};

registerStorageBackend(localFsStub, {
  provenance: 'builtin',
  source: 'libs/kernel/src/storage/storage-backend.test.ts',
});

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

  it('keeps object-storage-stub out of the default chain (registered but never auto-selected)', () => {
    expect(getStorageBackend(OBJECT_STORAGE_BACKEND_STUB_ID)).toBeDefined();
    expect(resolveStorageBackend(OBJECT_STORAGE_BACKEND_STUB_ID).id).toBe(
      OBJECT_STORAGE_BACKEND_STUB_ID
    );
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
  });

  it('exposes async methods on the governed default', async () => {
    const backend = resolveStorageBackend();
    await expect(backend.exists('/')).resolves.toBeTypeOf('boolean');
  });
  it('uses an injected default-order resolver and restores the builtin chain', () => {
    const restore = setStorageBackendDefaultOrderResolver(() => [
      'not-registered',
      MEMORY_STORAGE_BACKEND_ID,
    ]);
    try {
      expect(resolveStorageBackend().id).toBe(MEMORY_STORAGE_BACKEND_ID);
      expect(resolveStorageBackend(LOCAL_STORAGE_BACKEND_ID).id).toBe(LOCAL_STORAGE_BACKEND_ID);
    } finally {
      restore();
    }
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
  });

  it('falls back to the builtin chain when the resolver is empty, throws or re-enters', () => {
    const cases: Array<() => readonly string[]> = [
      () => [],
      () => {
        throw new Error('policy unavailable');
      },
      // Re-entrant: the inner call must use the builtin chain, not recurse.
      () => [resolveStorageBackend().id],
    ];
    for (const resolver of cases) {
      const restore = setStorageBackendDefaultOrderResolver(resolver);
      try {
        expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
      } finally {
        restore();
      }
    }
  });
});

describe('entry-ledger on a memory backend', () => {
  it('appends and reads entries back in order', async () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger<{ v: number }>('/state/test/ledger.jsonl', { backend });
    expect(await ledger.exists()).toBe(false);
    await ledger.append({ v: 1 });
    await ledger.append({ v: 2 });
    expect(await ledger.exists()).toBe(true);
    expect(await ledger.readAll()).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('accepts an already-async wrapped sync backend', async () => {
    const backend = toAsyncStorageBackend(createMemoryStorageBackend());
    const ledger = createEntryLedger<{ v: number }>('/state/test/wrapped.jsonl', { backend });
    await ledger.append({ v: 9 });
    expect(await ledger.readAll()).toEqual([{ v: 9 }]);
  });

  it('skips malformed lines by default and throws on request', async () => {
    const backend = createMemoryStorageBackend();
    const ledgerPath = '/state/test/mixed.jsonl';
    backend.append(ledgerPath, '{"ok":1}\nnot-json\n{"ok":2}\n');
    const lenient = createEntryLedger<{ ok: number }>(ledgerPath, { backend });
    expect(await lenient.readAll()).toEqual([{ ok: 1 }, { ok: 2 }]);
    const strict = createEntryLedger<{ ok: number }>(ledgerPath, {
      backend,
      onMalformed: 'throw',
    });
    await expect(strict.readAll()).rejects.toThrow();
  });

  it('drops rows rejected by the caller map under skip policy', async () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger<{ v: number }>('/state/test/mapped.jsonl', { backend });
    await ledger.append({ v: 1 });
    await ledger.append({ v: 2 });
    const seen = await ledger.readAll((value) => {
      const v = (value as { v: number }).v;
      if (v === 1) throw new Error('reject');
      return v === 2 ? { v } : null;
    });
    expect(seen).toEqual([{ v: 2 }]);
  });

  it('rejects a non-regular ledger path', async () => {
    const backend = createMemoryStorageBackend();
    const ledger = createEntryLedger('/state/test/dir-ledger', { backend });
    backend.mkdir('/state/test/dir-ledger');
    await expect(ledger.append({ v: 1 })).rejects.toThrow(/must be a regular file/);
  });

  it('lists directory children', () => {
    const backend = createMemoryStorageBackend();
    backend.append('/state/test/a.jsonl', '1\n');
    backend.append('/state/test/nested/b.jsonl', '2\n');
    expect(backend.list('/state/test')).toEqual(['a.jsonl', 'nested']);
  });
});

describe('object-storage async stub', () => {
  it('awaits append durability before readAll sees the entry', async () => {
    const backend = createObjectStorageBackendStub({ appendDelayMs: 5 });
    expect(backend.id).toBe(OBJECT_STORAGE_BACKEND_STUB_ID);
    const ledger = createEntryLedger<{ v: number }>('/bucket/ledger.jsonl', { backend });
    const started = Date.now();
    await ledger.append({ v: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(await ledger.readAll()).toEqual([{ v: 1 }]);
  });
});
