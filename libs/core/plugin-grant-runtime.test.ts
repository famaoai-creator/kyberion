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
  const managedRoot = pathResolver.shared(`plugins/managed-test-grant-${randomUUID()}`);

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
