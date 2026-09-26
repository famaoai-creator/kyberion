import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeWriteFile, validateUrl } from './secure-io.js';
import {
  assertSandboxWriteAllowed,
  getActiveSandboxPolicy,
  resolveSandboxPolicy,
  withSandboxPolicy,
} from './sandbox-policy.js';
import type { PluginPermissionGrant } from './plugin-permissions.js';
import { getSecret } from './secret-guard.js';
import {
  createPluginGrantBinding,
  EMPTY_PLUGIN_GRANT,
  getPluginEnv,
  isPluginGrantWithin,
  resolvePluginExecutionGrant,
  resolvePluginGrantPathRoot,
  runWithPluginGrant,
} from './plugin-grant-runtime.js';

function grant(overrides: Partial<PluginPermissionGrant> = {}): PluginPermissionGrant {
  return {
    network: { mode: 'none', hosts: [] },
    fs: { mode: 'none', paths: [] },
    ops_invoke: [],
    env: [],
    secrets: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runWithPluginGrant (EP-03)', () => {
  it('denies governed writes without an fs grant', () => {
    const target = pathResolver.sharedTmp(`plugin-grant-runtime-test/${randomUUID()}.txt`);
    expect(() =>
      runWithPluginGrant(EMPTY_PLUGIN_GRANT, 'no-fs', () => safeWriteFile(target, 'x'))
    ).toThrow(/SANDBOX_WRITE_DENIED/);
    expect(safeExistsSync(target)).toBe(false);
  });

  it('restricts readwrite grants to their tier roots', () => {
    const readwrite = grant({
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: 'plugin-scratch' }] },
    });
    runWithPluginGrant(readwrite, 'rw', () => {
      const root = resolvePluginGrantPathRoot('public', 'plugin-scratch');
      expect(root).toBe(pathResolver.rootResolve('knowledge/public/plugin-scratch'));
      expect(() => assertSandboxWriteAllowed(path.join(root, 'note.md'))).not.toThrow();
      expect(() =>
        assertSandboxWriteAllowed(pathResolver.rootResolve('knowledge/public/other.md'))
      ).toThrow('[SANDBOX_WRITE_DENIED]');
      expect(() =>
        safeWriteFile(pathResolver.sharedTmp(`plugin-grant-runtime-test/${randomUUID()}`), 'x')
      ).toThrow(/SANDBOX_WRITE_DENIED/);
    });
    const readonly = grant({
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: '' }] },
    });
    runWithPluginGrant(readonly, 'ro', () => {
      expect(getActiveSandboxPolicy()?.mode).toBe('read-only');
    });
  });

  it('never widens an outer read-only policy', () => {
    const outer = resolveSandboxPolicy({ mode: 'read-only', networkAccess: false });
    const wide = grant({
      network: { mode: 'allowlist', hosts: ['*'] },
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
    });
    withSandboxPolicy(outer, () =>
      runWithPluginGrant(wide, 'wide', () => {
        expect(getActiveSandboxPolicy()).toMatchObject({
          mode: 'read-only',
          networkAccess: false,
        });
        expect(() =>
          assertSandboxWriteAllowed(pathResolver.rootResolve('knowledge/public/x.md'))
        ).toThrow('[SANDBOX_WRITE_DENIED]');
      })
    );
  });

  it('denies network to hosts outside the grant', () => {
    runWithPluginGrant(EMPTY_PLUGIN_GRANT, 'offline', () => {
      expect(() => validateUrl('https://example.com')).toThrow('SANDBOX_NETWORK_DENIED');
    });
    runWithPluginGrant(
      grant({ network: { mode: 'allowlist', hosts: ['api.example.com'] } }),
      'allowlisted',
      () => {
        expect(() => validateUrl('https://api.example.com/v1')).not.toThrow();
        expect(() => validateUrl('https://example.org')).toThrow('SANDBOX_NETWORK_DENIED');
      }
    );
    runWithPluginGrant(grant({ network: { mode: 'loopback', hosts: [] } }), 'loopback', () => {
      expect(getActiveSandboxPolicy()?.networkAllowlist).toEqual(['127.0.0.1', '::1', 'localhost']);
      expect(() => validateUrl('https://example.org')).toThrow('SANDBOX_NETWORK_DENIED');
    });
  });

  it('exposes only granted env variables through the cooperative view', () => {
    vi.stubEnv('PLUGIN_FIXTURE_TOKEN', 'granted');
    vi.stubEnv('PLUGIN_OTHER_TOKEN', 'hidden');
    expect(getPluginEnv()).toEqual({});
    const view = runWithPluginGrant(grant({ env: ['PLUGIN_FIXTURE_*'] }), 'env', () =>
      getPluginEnv()
    );
    expect(view).toEqual({ PLUGIN_FIXTURE_TOKEN: 'granted' });
  });
});

describe('plugin grant binding and comparison', () => {
  it('narrows in place but refuses widening, and leaves legacy plugins unwrapped', () => {
    const binding = createPluginGrantBinding('b', grant({ ops_invoke: ['a:*'], env: ['X'] }));
    binding.narrow(grant({ ops_invoke: ['a:run'] }));
    expect(binding.grant?.ops_invoke).toEqual(['a:run']);
    expect(() => binding.narrow(grant({ ops_invoke: ['*'] }))).toThrow(
      '[PLUGIN_GRANT_WIDEN_DENIED]'
    );

    const legacy = createPluginGrantBinding('legacy', null);
    const fn = () => getActiveSandboxPolicy();
    expect(legacy.wrapFunction(fn)).toBe(fn);
    expect(legacy.run(fn)).toBeUndefined();
    expect(() => legacy.narrow(EMPTY_PLUGIN_GRANT)).toThrow('[PLUGIN_GRANT_RELOAD_REQUIRED]');
  });

  it('wraps results deeply but leaves pure data and frozen objects usable', async () => {
    const binding = createPluginGrantBinding('deep', EMPTY_PLUGIN_GRANT);
    const data = { rows: [1, 2], nested: { label: 'x' } };
    const frozen = Object.freeze({ policy: () => getActiveSandboxPolicy()?.mode });
    const api = binding.wrapObject({
      data: () => data,
      frozen: () => frozen,
      *sync(): Generator<string | undefined> {
        yield getActiveSandboxPolicy()?.mode;
      },
      fluent() {
        return this;
      },
    });
    expect(api.data()).toBe(data);
    expect(structuredClone(api.data())).toEqual(data);
    expect(api.frozen().policy()).toBe('read-only');
    expect(await Promise.resolve(api.frozen()).then((value) => value.policy())).toBe('read-only');
    expect([...api.sync()]).toEqual(['read-only']);
    expect(api.fluent()).toBe(api);
    expect(api.frozen).toBe(api.frozen);
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('wraps closures carried by returned arrays, Map and Set (N1)', () => {
    vi.stubEnv('PLUGIN_ARRAY_SECRET', 'array-secret-value');
    const target = pathResolver.sharedTmp(`plugin-grant-runtime-test/${randomUUID()}.txt`);
    const fetchProbe = () => validateUrl('https://example.com');
    const binding = createPluginGrantBinding('containers', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({
      list: () => [fetchProbe, () => safeWriteFile(target, 'x')],
      tools: () => ({ tools: [{ name: 't', execute: () => getSecret('PLUGIN_ARRAY_SECRET') }] }),
      map: () => new Map([['fetch', fetchProbe]]),
      set: () => new Set([fetchProbe]),
      holder: { items: [{ handler: fetchProbe }] },
    });

    const list = api.list();
    expect(Array.isArray(list)).toBe(true);
    expect(() => list[0]()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(() => list[1]()).toThrow(/SANDBOX_WRITE_DENIED/);
    expect(safeExistsSync(target)).toBe(false);
    expect(() => api.tools().tools[0].execute()).toThrow('[PLUGIN_GRANT_DENIED]');
    expect(() => api.map().get('fetch')!()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(() => [...api.set()][0]()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(() => api.holder.items[0].handler()).toThrow('SANDBOX_NETWORK_DENIED');
    // Pure data collections stay the same (cloneable) objects.
    const rows = [1, 2];
    const table = new Map([['a', 1]]);
    const data = binding.wrapObject({ rows: () => rows, table: () => table });
    expect(data.rows()).toBe(rows);
    expect(data.table()).toBe(table);
  });

  it('re-scans mutable data but caches frozen data verdicts (N2e)', () => {
    let reads = 0;
    const frozenRows = Object.freeze(Array.from({ length: 500 }, (_, i) => Object.freeze({ i })));
    const counted = new Proxy(frozenRows, {
      ownKeys: (rows) => {
        reads += 1;
        return Reflect.ownKeys(rows);
      },
      getOwnPropertyDescriptor: (rows, key) => {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(rows, key);
      },
    });
    const mutable: unknown[] = [1, 2];
    const binding = createPluginGrantBinding('scan-cache', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({ frozen: () => counted, mutable: () => mutable });
    expect(api.frozen()).toBe(counted);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    expect(api.frozen()).toBe(counted);
    expect(api.frozen()).toBe(counted);
    expect(reads).toBe(0);

    expect(api.mutable()).toBe(mutable);
    mutable.push(() => validateUrl('https://example.com'));
    const later = api.mutable() as Array<() => void>;
    expect(later).not.toBe(mutable);
    expect(() => later[2]()).toThrow('SANDBOX_NETWORK_DENIED');
  });

  it('keeps proxies consistent under freeze / defineProperty (N2a)', () => {
    const binding = createPluginGrantBinding('freeze', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({
      make: () => ({ label: 'x', mode: () => getActiveSandboxPolicy()?.mode }),
      frozen: () => Object.freeze({ mode: () => getActiveSandboxPolicy()?.mode }),
    });
    const made = api.make();
    Object.defineProperty(made, 'pinned', { value: 1, configurable: false, writable: false });
    expect(made.pinned).toBe(1);
    expect(Object.getOwnPropertyDescriptor(made, 'pinned')).toMatchObject({
      value: 1,
      configurable: false,
    });
    expect(Object.freeze(made)).toBe(made);
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isExtensible(made)).toBe(false);
    expect(Reflect.ownKeys(made)).toEqual(['label', 'mode', 'pinned']);
    expect(made.mode()).toBe('read-only');
    expect(made.mode).toBe(made.mode);

    const frozen = api.frozen();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.mode()).toBe('read-only');
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('supports new on members and returned classes, keeping statics and instanceof (N2b/c)', () => {
    class Widget {
      static kind(): string | undefined {
        return getActiveSandboxPolicy()?.mode;
      }
      readonly built = getActiveSandboxPolicy()?.mode;
      probe(): string | undefined {
        return getActiveSandboxPolicy()?.mode;
      }
    }
    const binding = createPluginGrantBinding('classes', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({ Widget, cls: () => Widget });

    const member = new api.Widget();
    expect(member.built).toBe('read-only');
    expect(member.probe()).toBe('read-only');
    expect(member instanceof api.Widget).toBe(true);
    expect(api.Widget.kind()).toBe('read-only');

    const Returned = api.cls();
    const instance = new Returned();
    expect(instance.built).toBe('read-only');
    expect(instance instanceof Returned).toBe(true);
    expect(instance instanceof Widget).toBe(true);
    expect(Returned.kind()).toBe('read-only');
    expect(Returned.name).toBe('Widget');
    expect(Returned.length).toBe(0);
    expect(Returned.prototype).toBe(Widget.prototype);
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('re-wraps a collection copy the plugin mutated and handed back (B1)', () => {
    const escape = () => validateUrl('https://example.com');
    const binding = createPluginGrantBinding('round-trip', EMPTY_PLUGIN_GRANT);
    // The host keeps a proxied context and hands it to another plugin op.
    const ctx = binding.wrapObject({ tools: [() => 'ok'] });
    const plugin = binding.wrapObject({
      returnCopy: (context: { tools: unknown[] }) => {
        const copy = context.tools;
        copy.push(escape);
        return copy;
      },
      returnHolder: (context: { tools: unknown[] }) => {
        const copy = context.tools;
        copy.push(escape);
        return { tools: copy };
      },
    });
    const direct = plugin.returnCopy(ctx) as Array<() => unknown>;
    expect(() => direct[1]()).toThrow('SANDBOX_NETWORK_DENIED');
    const holder = plugin.returnHolder(ctx) as { tools: Array<() => unknown> };
    expect(() => holder.tools[holder.tools.length - 1]()).toThrow('SANDBOX_NETWORK_DENIED');
    // The host's own view is refreshed, never the mutated copy.
    expect(ctx.tools).toHaveLength(1);
  });

  it('returns deep pure data as-is and does not cache budget overruns (S1)', () => {
    const binding = createPluginGrantBinding('deep-data', EMPTY_PLUGIN_GRANT);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let level = 0; level < 8; level += 1) {
      const next: Record<string, unknown> = {};
      for (let key = 0; key < 125; key += 1) deep[`k${key}`] = key;
      deep.next = next;
      deep = next;
    }
    const api = binding.wrapObject({ deep: () => root });
    expect(api.deep()).toBe(root);
    expect(structuredClone(api.deep())).toEqual(root);

    const huge = { child: { rows: Array.from({ length: 10_001 }, (_, i) => ({ i })) } };
    const hugeApi = binding.wrapObject({ huge: () => huge, child: () => huge.child });
    expect(hugeApi.huge()).not.toBe(huge);
    huge.child.rows = [];
    expect(hugeApi.child()).toBe(huge.child);
    expect(hugeApi.huge()).toBe(huge);
  });

  it('keeps a wrapped collection copy stable until either side mutates it (S2)', () => {
    const binding = createPluginGrantBinding('memo', EMPTY_PLUGIN_GRANT);
    const raw = { tools: [() => getActiveSandboxPolicy()?.mode] as Array<() => unknown> };
    const w = binding.wrapObject(raw);
    const first = w.tools;
    expect(w.tools).toBe(first);
    expect(first[0]()).toBe('read-only');

    raw.tools.push(() => validateUrl('https://example.com'));
    const refreshed = w.tools;
    expect(refreshed).not.toBe(first);
    expect(refreshed).toHaveLength(2);
    expect(() => refreshed[1]()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(w.tools).toBe(refreshed);

    refreshed.push(() => 'host write');
    expect(w.tools).not.toBe(refreshed);
    expect(w.tools).toHaveLength(2);

    // A closure slipped into a nested copy never survives a cached read.
    const nested = binding.wrapObject({ groups: [[() => 'ok']] as Array<Array<() => unknown>> });
    nested.groups[0].push(() => validateUrl('https://example.com'));
    const group = nested.groups[0];
    expect(group).toHaveLength(1);
    const mixed = binding.wrapObject({
      rows: [() => 'ok', { label: 'data' }] as Array<unknown>,
    });
    const rows = mixed.rows;
    expect(mixed.rows).toBe(rows);
    (rows[1] as Record<string, unknown>).probe = () => validateUrl('https://example.com');
    const rescanned = mixed.rows as Array<{ probe: () => unknown }>;
    expect(rescanned).not.toBe(rows);
    expect(() => rescanned[1].probe()).toThrow('SANDBOX_NETWORK_DENIED');
  });

  it('reuses nested collection copies until any level changes (FU-05)', () => {
    const binding = createPluginGrantBinding('nested-memo', EMPTY_PLUGIN_GRANT);
    const raw = {
      groups: [[() => getActiveSandboxPolicy()?.mode]] as Array<Array<() => unknown>>,
      table: [new Map([['run', () => getActiveSandboxPolicy()?.mode]])],
    };
    const w = binding.wrapObject(raw);
    const first = w.groups;
    expect(w.groups).toBe(first);
    expect(first[0]).toBe(w.groups[0]);
    expect(first[0][0]()).toBe('read-only');
    expect(w.table).toBe(w.table);
    expect(w.table[0].get('run')!()).toBe('read-only');

    // The plugin mutates an inner level.
    raw.groups[0].push(() => validateUrl('https://example.com'));
    const refreshed = w.groups;
    expect(refreshed).not.toBe(first);
    expect(refreshed[0]).toHaveLength(2);
    expect(() => refreshed[0][1]()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(w.groups).toBe(refreshed);

    // A raw closure pushed into a nested copy never survives a cached read.
    const escape = () => validateUrl('https://example.com');
    refreshed[0].push(escape);
    const again = w.groups;
    expect(again).not.toBe(refreshed);
    expect(again[0]).toHaveLength(2);
    expect(again[0]).not.toContain(escape);

    // A closure added to a shared data element of a nested copy forces a fresh copy.
    const mixed = { rows: [[() => 'ok', { label: 'data' }]] as Array<Array<unknown>> };
    const wm = binding.wrapObject(mixed);
    const rows = wm.rows;
    expect(wm.rows).toBe(rows);
    (mixed.rows[0][1] as Record<string, unknown>).probe = () => validateUrl('https://example.com');
    const rescanned = wm.rows as Array<Array<{ probe: () => unknown }>>;
    expect(rescanned).not.toBe(rows);
    expect(() => rescanned[0][1].probe()).toThrow('SANDBOX_NETWORK_DENIED');
  });

  it('copies over-budget pure data instead of proxying it (FU-05)', () => {
    const binding = createPluginGrantBinding('big-data', EMPTY_PLUGIN_GRANT);
    const big = {
      meta: { version: 1 },
      rows: Array.from({ length: 20_000 }, (_, i) => ({ i, tag: `r${i}` })),
    };
    const hidden = {
      rows: Array.from({ length: 20_000 }, (_, i) => ({ i })),
      deep: { a: { b: { run: () => validateUrl('https://example.com') } } },
    };
    const api = binding.wrapObject({
      big: () => big,
      hidden: () => hidden,
    });

    const result = api.big();
    expect(Array.isArray(result.rows)).toBe(true);
    expect(structuredClone(result)).toEqual(big);
    // Subtrees that fit the scan budget are shared, not copied.
    expect(result.rows[5]).toBe(big.rows[5]);

    const found = api.hidden();
    expect(() => found.deep.a.b.run()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(getActiveSandboxPolicy()).toBeUndefined();

    // Read through an object wrapper, the copy is memoised until the plugin mutates it.
    const holder = binding.wrapObject({ big });
    expect(holder.big).toBe(holder.big);
    expect(structuredClone(holder.big)).toEqual(big);
    big.meta.version = 2;
    expect(holder.big.meta.version).toBe(2);
  });

  it('does not re-scan over-budget data on property reads (FU-05)', () => {
    let scans = 0;
    const counted = new Proxy(
      { i: -1 },
      {
        ownKeys: (target) => {
          scans += 1;
          return Reflect.ownKeys(target);
        },
      }
    );
    const withProbe = { rows: [counted, ...Array.from({ length: 20_000 }, (_, i) => ({ i }))] };
    const binding = createPluginGrantBinding('big-reads', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({ withProbe: () => withProbe });
    const probed = api.withProbe();
    scans = 0;
    for (let read = 0; read < 3; read += 1) {
      expect(probed.rows[0].i).toBe(-1);
      expect(probed.rows).toHaveLength(20_001);
    }
    expect(scans).toBe(0);
  });

  it('bounds copies of deep chains and still enforces the grant at the bottom (FU-05)', () => {
    const binding = createPluginGrantBinding('deep-chain', EMPTY_PLUGIN_GRANT);
    type Link = { next?: Link; run?: () => unknown };
    const root: Link = {};
    let cursor = root;
    for (let level = 0; level < 5_000; level += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.run = () => validateUrl('https://example.com');
    const api = binding.wrapObject({ chain: () => root });
    let walk = api.chain();
    for (let level = 0; level < 5_000; level += 1) walk = walk.next!;
    expect(() => walk.run!()).toThrow('SANDBOX_NETWORK_DENIED');
  });

  /** Proxy handler whose every trap attempts a network call and records the verdict. */
  const probingHandler = (attempts: string[]): ProxyHandler<object> => {
    const probe = (trap: string): void => {
      try {
        validateUrl('https://example.com');
        attempts.push(`${trap}:allowed`);
      } catch {
        attempts.push(`${trap}:denied`);
      }
    };
    return {
      has: (target, property) => (probe('has'), Reflect.has(target, property)),
      ownKeys: (target) => (probe('ownKeys'), Reflect.ownKeys(target)),
      deleteProperty: (target, property) => (
        probe('deleteProperty'),
        Reflect.deleteProperty(target, property)
      ),
      defineProperty: (target, property, descriptor) => (
        probe('defineProperty'),
        Reflect.defineProperty(target, property, descriptor)
      ),
      getPrototypeOf: (target) => (probe('getPrototypeOf'), Reflect.getPrototypeOf(target)),
      setPrototypeOf: (target, prototype) => (
        probe('setPrototypeOf'),
        Reflect.setPrototypeOf(target, prototype)
      ),
      isExtensible: (target) => (probe('isExtensible'), Reflect.isExtensible(target)),
      preventExtensions: (target) => (
        probe('preventExtensions'),
        Reflect.preventExtensions(target)
      ),
      getOwnPropertyDescriptor: (target, property) => (
        probe('getOwnPropertyDescriptor'),
        Reflect.getOwnPropertyDescriptor(target, property)
      ),
      set: (target, property, value) => (probe('set'), Reflect.set(target, property, value)),
    };
  };

  it('runs plugin-supplied proxy traps on object wrappers inside the grant (FU-05)', () => {
    const attempts: string[] = [];
    const binding = createPluginGrantBinding('proxy-traps', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({
      make: () => new Proxy({ run: () => 1, extra: 1 }, probingHandler(attempts)),
    });
    const made = api.make() as Record<string, unknown>;
    attempts.length = 0;
    expect('extra' in made).toBe(true);
    expect(Reflect.ownKeys(made)).toContain('extra');
    expect(Object.getOwnPropertyDescriptor(made, 'extra')).toBeDefined();
    made.extra = 2;
    expect(delete made.extra).toBe(true);
    Object.defineProperty(made, 'added', { value: 1, configurable: true, writable: true });
    expect(Object.getPrototypeOf(made)).toBe(Object.prototype);
    Object.setPrototypeOf(made, Object.prototype);
    expect(Object.isExtensible(made)).toBe(true);
    Object.preventExtensions(made);
    expect(Object.isExtensible(made)).toBe(false);
    expect(attempts.filter((entry) => entry.endsWith(':allowed'))).toEqual([]);
    expect(new Set(attempts.map((entry) => entry.split(':')[0]))).toEqual(
      new Set([
        'has',
        'ownKeys',
        'deleteProperty',
        'defineProperty',
        'getPrototypeOf',
        'setPrototypeOf',
        'isExtensible',
        'preventExtensions',
        'getOwnPropertyDescriptor',
        'set',
      ])
    );
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('wraps a plugin Proxy function over a host shadow (FU-05)', () => {
    // Reflection never reaches the plugin's traps (not even the engine's
    // Proxy invariant checks); reads, writes and calls run under the grant.
    const attempts: string[] = [];
    const binding = createPluginGrantBinding('proxy-function', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({
      tool: () => new Proxy(function tool() {}, probingHandler(attempts)),
    });
    const tool = api.tool() as unknown as Record<string, unknown> & (() => unknown);
    attempts.length = 0;
    tool.extra = 1;
    expect(tool.extra).toBe(1);
    expect('extra' in tool).toBe(false);
    expect(Reflect.ownKeys(tool)).not.toContain('extra');
    expect(Object.getOwnPropertyDescriptor(tool, 'extra')).toBeUndefined();
    expect(Object.getPrototypeOf(tool)).toBe(Function.prototype);
    expect(Object.isExtensible(tool)).toBe(true);
    expect(tool()).toBeUndefined();
    expect(attempts.filter((entry) => entry.endsWith(':allowed'))).toEqual([]);
    expect(attempts).toContain('set:denied');
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('wraps a plugin Proxy function prototype so it runs under the grant (S9)', () => {
    // The shadow target's own `prototype` is writable, so wrapping the
    // reported value is invariant-safe (unlike the raw-prototype case for
    // ordinary function/class targets covered above).
    function tool(): void {}
    (tool as unknown as { prototype: Record<string, unknown> }).prototype.run = () =>
      validateUrl('https://example.com');
    const binding = createPluginGrantBinding('proxy-function-prototype', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({ make: () => new Proxy(tool, {}) });
    const made = api.make() as unknown as { prototype: { run: () => string } };
    expect(() => made.prototype.run()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(getActiveSandboxPolicy()).toBeUndefined();
  });

  it('runs `in` on a function wrapper under the grant when its prototype is a plugin Proxy (FU-05)', () => {
    const attempts: string[] = [];
    function tool(): void {}
    Object.setPrototypeOf(tool, new Proxy(Function.prototype, probingHandler(attempts)));
    const binding = createPluginGrantBinding('proxy-prototype', EMPTY_PLUGIN_GRANT);
    const wrapped = binding.wrapFunction(tool);
    attempts.length = 0;
    expect('missing' in wrapped).toBe(false);
    expect(attempts).toEqual(['has:denied']);
  });

  it('subscribes to promise subclasses inside the grant (S3)', async () => {
    const attempts: string[] = [];
    class SneakyPromise<T> extends Promise<T> {
      override then<R1 = T, R2 = never>(
        onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
        onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
      ): Promise<R1 | R2> {
        try {
          validateUrl('https://example.com');
          attempts.push('allowed');
        } catch {
          attempts.push('denied');
        }
        return super.then(onFulfilled, onRejected);
      }
    }
    const binding = createPluginGrantBinding('promise-subclass', EMPTY_PLUGIN_GRANT);
    const api = binding.wrapObject({ value: () => SneakyPromise.resolve(5) });
    await expect(api.value()).resolves.toBe(5);
    expect(attempts).not.toContain('allowed');
  });

  it('passes data-only error subclasses through unchanged so host logs stay readable', () => {
    const binding = createPluginGrantBinding('data-error', EMPTY_PLUGIN_GRANT);
    class CodedError extends Error {
      code = 'E_PLUGIN';
    }
    const original = new CodedError('coded');
    const api = binding.wrapObject({
      fail: () => {
        throw original;
      },
    });
    let caught: unknown;
    try {
      api.fail();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(structuredClone(caught)).toMatchObject({ message: 'coded' });
  });

  it('wraps thrown values and errors carrying executables (S4)', async () => {
    const binding = createPluginGrantBinding('throws', EMPTY_PLUGIN_GRANT);
    const withRetry = Object.assign(new Error('boom'), {
      retry: () => validateUrl('https://example.com'),
    });
    class PluginError extends Error {
      get detail(): string {
        validateUrl('https://example.com');
        return 'reached';
      }
    }
    const plain = new TypeError('plain');
    const api = binding.wrapObject({
      fail: () => {
        throw withRetry;
      },
      failClass: () => {
        throw new PluginError('class');
      },
      failPlain: () => {
        throw plain;
      },
      reject: async () => {
        throw withRetry;
      },
      returnError: () => withRetry,
    });
    type Caught = Error & { retry: () => unknown; detail: string };
    const caught = (fn: () => unknown): Caught => {
      try {
        fn();
      } catch (error) {
        return error as Caught;
      }
      throw new Error('expected a throw');
    };
    const thrown = caught(() => api.fail());
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('boom');
    expect(() => thrown.retry()).toThrow('SANDBOX_NETWORK_DENIED');
    const classed = caught(() => api.failClass());
    expect(classed).toBeInstanceOf(PluginError);
    expect(classed).toBeInstanceOf(Error);
    expect(() => classed.detail).toThrow('SANDBOX_NETWORK_DENIED');
    expect(caught(() => api.failPlain())).toBe(plain);
    const rejected = (await api.reject().then(
      () => undefined,
      (error: unknown) => error
    )) as Caught;
    expect(() => rejected.retry()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(() => (api.returnError() as typeof withRetry).retry()).toThrow('SANDBOX_NETWORK_DENIED');
  });

  it('reports wrapped accessors and writable values on function wrappers (S5)', () => {
    function tool(): void {}
    Object.defineProperty(tool, 'probe', {
      get: () => validateUrl('https://example.com'),
      configurable: true,
    });
    Object.defineProperty(tool, 'pinned', {
      value: () => validateUrl('https://example.com'),
      writable: true,
      configurable: false,
    });
    const binding = createPluginGrantBinding('descriptors', EMPTY_PLUGIN_GRANT);
    const wrapped = binding.wrapFunction(tool);
    const probe = Object.getOwnPropertyDescriptor(wrapped, 'probe')!;
    expect(() => probe.get!()).toThrow('SANDBOX_NETWORK_DENIED');
    const pinned = Object.getOwnPropertyDescriptor(wrapped, 'pinned')!;
    expect(pinned.configurable).toBe(false);
    expect(() => (pinned.value as () => unknown)()).toThrow('SANDBOX_NETWORK_DENIED');
    expect(Object.getOwnPropertyDescriptor(wrapped, 'prototype')?.value).toBe(tool.prototype);
  });

  it('compares grants capability by capability', () => {
    const wide = grant({
      network: { mode: 'allowlist', hosts: ['*.example.com'] },
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
      ops_invoke: ['a:*'],
    });
    const narrow = grant({
      network: { mode: 'allowlist', hosts: ['api.example.com'] },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] },
      ops_invoke: ['a:run'],
    });
    expect(isPluginGrantWithin(narrow, wide)).toBe(true);
    expect(isPluginGrantWithin(wide, narrow)).toBe(false);
    expect(isPluginGrantWithin(grant({ network: { mode: 'loopback', hosts: [] } }), wide)).toBe(
      false
    );
    expect(isPluginGrantWithin(wide, null)).toBe(true);
    expect(isPluginGrantWithin(null, wide)).toBe(false);
  });
});

describe('resolvePluginExecutionGrant policy for undeclared permissions', () => {
  const managedRoot = pathResolver.sharedTmp(`plugins/managed-test-grant-${randomUUID()}`);

  it('gives an undeclared third-party plugin the empty grant', () => {
    const resolved = resolvePluginExecutionGrant(
      { pluginId: 'tp', sourcePath: '/managed/unknown/index.mjs', trust: 'third-party' },
      { managedRoot }
    );
    expect(resolved.source).toBe('deny_by_default');
    expect(resolved.grant).toEqual(EMPTY_PLUGIN_GRANT);
  });

  it('never lets a third-party caller opt out of wrapping with null', () => {
    const resolved = resolvePluginExecutionGrant(
      { pluginId: 'tp', sourcePath: '/managed/x', trust: 'third-party', grant: null },
      { managedRoot }
    );
    expect(resolved.grant).toEqual(EMPTY_PLUGIN_GRANT);
  });

  it('leaves undeclared official plugins (incl. the legacy Cowork shape) unwrapped', () => {
    const undeclared = resolvePluginExecutionGrant({
      pluginId: 'contribution-fixture',
      sourcePath: pathResolver.rootResolve(
        'plugins/fixtures/skill-plugin-loader-contribution-fixture/index.mjs'
      ),
      trust: 'official',
    });
    expect(undeclared).toMatchObject({ grant: null, source: 'undeclared_official' });

    const cowork = resolvePluginExecutionGrant({
      pluginId: 'kyberion',
      sourcePath: pathResolver.rootResolve('plugins/kyberion/index.mjs'),
      trust: 'official',
    });
    expect(cowork).toMatchObject({ grant: null, source: 'undeclared_official' });
  });

  it('wraps a declared official plugin with its narrowed grant', () => {
    const resolved = resolvePluginExecutionGrant({
      pluginId: 'plugin-permissions-fixture',
      sourcePath: pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture/index.mjs'),
      trust: 'official',
    });
    expect(resolved.source).toBe('manifest_declaration');
    expect(resolved.grant).toMatchObject({
      network: { mode: 'none' },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: '' }] },
      ops_invoke: ['permfixture:env'],
      env: ['PLUGIN_FIXTURE_*'],
      secrets: [],
    });
  });
});
