import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { linkMission, loadSnapshot, type LoaderDeps } from './loaders.js';
import { DeckEngine } from './engine.js';
import { createWorkerHost, type DeckHost, type WorkerLike } from './host.js';
import { EMPTY_SNAPSHOT, type DeckSnapshot } from '../model/types.js';

function deps(overrides: Partial<LoaderDeps> = {}): LoaderDeps {
  return {
    scope: () => ({ tier: 'confidential', tenant_slug: 'acme' }) as never,
    homeSummary: () => ({ activeMissions: [], pendingApprovals: [] }) as never,
    missions: () =>
      [
        {
          id: 'MSN-ACME-1',
          status: 'active',
          tier: 'confidential',
          tenantSlug: 'acme',
          checkpoints: 0,
        },
      ] as never,
    herdr: () =>
      ({
        listAgents: () => [
          { pane_id: 'p1', name: 'MSN-ACME-1-claude', agent: 'claude', agent_status: 'working' },
          { pane_id: 'p2', name: 'other-tenant-codex', agent: 'codex', agent_status: 'working' },
        ],
        listPanes: () => [],
        readAgent: () => 'line\n',
      }) as never,
    collaborationWaitingOnHuman: () => 0,
    ...overrides,
  };
}

describe('loadSnapshot scope', () => {
  it('fails closed when the scope cannot be resolved', () => {
    const missions = vi.fn(() => []);
    const snapshot = loadSnapshot(
      {},
      deps({
        scope: () => {
          throw new Error('no scope');
        },
        missions,
      })
    );
    expect(missions).not.toHaveBeenCalled();
    expect(snapshot.missions).toEqual([]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.health).toEqual([{ source: 'scope', ok: false, detail: 'no scope' }]);
  });

  it('under a tenant scope shows only agents linked to in-scope missions', () => {
    const snapshot = loadSnapshot({}, deps());
    expect(snapshot.agents.map((a) => a.target)).toEqual(['MSN-ACME-1-claude']);
  });

  it('without a tenant scope keeps unlinked agents', () => {
    const snapshot = loadSnapshot({}, deps({ scope: () => ({ tier: 'public' }) as never }));
    expect(snapshot.agents).toHaveLength(2);
  });

  it('reports herdr failures as unavailable agents instead of throwing', () => {
    const snapshot = loadSnapshot(
      {},
      deps({
        herdr: () => {
          throw new Error('herdr missing');
        },
      })
    );
    expect(snapshot.agentsAvailable).toBe(false);
    expect(snapshot.agentsUnavailableReason).toBe('herdr missing');
  });
});

describe('DeckEngine', () => {
  it('reloads right away in the new language when the locale changes', () => {
    const emitted: DeckSnapshot[] = [];
    const engine = new DeckEngine((s) => emitted.push(s), { locale: 'en', loaderDeps: deps() });
    engine.setLocale('ja');
    expect(emitted).toHaveLength(1);
    expect((engine as unknown as { options: { locale?: string } }).options.locale).toBe('ja');
  });

  it('keeps the last snapshot and marks it stale when loading throws', () => {
    const emitted: DeckSnapshot[] = [];
    const engine = new DeckEngine((s) => emitted.push(s), { loaderDeps: deps() });
    engine.refresh();
    expect(emitted[0]!.missions).toHaveLength(1);
    // a loader dependency that throws outside its own guard
    // A value that throws when read outside the per-source guards.
    (engine as unknown as { options: { loaderDeps: LoaderDeps } }).options.loaderDeps = deps({
      homeSummary: () =>
        ({
          get activeMissions(): never {
            throw new Error('home exploded');
          },
        }) as never,
    });
    expect(() => engine.refresh()).not.toThrow();
    const last = emitted.at(-1)!;
    expect(last.missions).toHaveLength(1);
    expect(last.health.find((h) => h.source === 'engine')).toMatchObject({
      ok: false,
      detail: 'home exploded',
    });
  });
});

class FakeWorker extends EventEmitter implements WorkerLike {
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  unref(): void {}
}

function fallbackHost(): DeckHost & { emit: (s: DeckSnapshot) => void } {
  let listener: ((s: DeckSnapshot) => void) | undefined;
  return {
    mode: 'inline',
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    emit: (s) => listener?.(s),
    request: async () => ({ ok: true, message: 'inline' }),
    refresh: vi.fn(),
    setLocale: vi.fn(),
    stop: vi.fn(),
  };
}

describe('createWorkerHost', () => {
  it('rejects pending requests and fails over in-process when the worker dies', async () => {
    const worker = new FakeWorker();
    const inline = fallbackHost();
    const host = createWorkerHost(
      {},
      () => inline,
      () => worker
    );
    const seen: DeckSnapshot[] = [];
    host.subscribe((s) => seen.push(s));

    const pending = host.request({ op: 'agentInterrupt', target: 'p1' });
    worker.emit('exit', 1);
    await expect(pending).rejects.toThrow('data worker exited (code 1)');
    expect(host.mode).toBe('inline');

    await expect(host.request({ op: 'agentInterrupt', target: 'p1' })).resolves.toEqual({
      ok: true,
      message: 'inline',
    });
    inline.emit(EMPTY_SNAPSHOT);
    expect(seen.at(-1)!.health).toContainEqual({
      source: 'worker',
      ok: false,
      detail: 'data worker exited (code 1)',
    });
  });

  it('treats a fatal message before the first snapshot as a failover, not an endless "loading"', () => {
    const worker = new FakeWorker();
    const inline = fallbackHost();
    const host = createWorkerHost(
      {},
      () => inline,
      () => worker
    );
    worker.emit('message', { type: 'fatal', error: 'module not found' });
    expect(host.mode).toBe('inline');
  });

  it('sends a locale switch to the worker, and to the fallback after a failover', () => {
    const worker = new FakeWorker();
    const inline = fallbackHost();
    const factory = vi.fn(() => inline);
    const host = createWorkerHost(
      { locale: 'en', operatorBaseRole: 'worker' },
      factory,
      () => worker
    );
    expect(worker.posted[0]).toMatchObject({
      type: 'config',
      locale: 'en',
      operatorBaseRole: 'worker',
    });
    host.setLocale('ja');
    expect(worker.posted.at(-1)).toEqual({ type: 'locale', locale: 'ja' });
    worker.emit('exit', 1);
    // the fallback starts in the language the operator switched to
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ja' }));
    host.setLocale('en');
    expect(inline.setLocale).toHaveBeenCalledWith('en');
  });

  it('does not fail over on a deliberate stop', () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => fallbackHost());
    const host = createWorkerHost({}, factory, () => worker);
    host.stop();
    worker.emit('exit', 0);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('linkMission', () => {
  const known = new Set(['MSN-A-1', 'MSN-A-10', 'MSN-TUI-DECK-20261120']);
  it('matches whole ids in names and worktree paths', () => {
    expect(linkMission('MSN-A-1-claude', known)).toBe('MSN-A-1');
    expect(linkMission('/w/kyberion-msn-tui-deck-20261120/', known)).toBe('MSN-TUI-DECK-20261120');
    expect(linkMission('MSN-A-10 codex', known)).toBe('MSN-A-10');
    expect(linkMission('MSN-A-100', known)).toBeUndefined();
    expect(linkMission('plain', known)).toBeUndefined();
  });
});
