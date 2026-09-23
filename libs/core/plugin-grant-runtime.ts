/**
 * EP-03: runtime enforcement of an approved plugin permission grant.
 *
 * Every executable contribution a plugin registers (op handlers, hooks,
 * preflight listeners/guards, seam implementations, reasoning providers and
 * the activation callback itself) runs inside `runWithPluginGrant`, which
 * installs the INTERSECTION of the enclosing sandbox policy and the grant
 * (never wider than either) plus a plugin execution frame that the op
 * preflight (`ops_invoke`) and secret-guard (`secrets`) consult.
 *
 * This is COOPERATIVE enforcement, not a security boundary: it mediates the
 * governed paths (secure-io writes, validateUrl / sandbox network checks,
 * op preflight, getSecret). In-process plugin code that imports `node:fs`,
 * opens sockets directly or reads `process.env` is not stopped. Filesystem
 * READS are not restricted either — the sandbox model has no read axis, so
 * `fs: none` only denies writes. Treat an approved third-party plugin as
 * code you run with the host's privileges; the grant limits what the
 * governed surfaces will do on its behalf.
 *
 * Grant resolution (`resolvePluginExecutionGrant`):
 * - third-party / curated: the approved managed record's `grantedPermissions`;
 *   anything without one gets the empty grant (deny by default).
 * - official with an EP-02 declaration: its grant (record, else narrowed now).
 * - official without an EP-02 declaration (absent, or the legacy Cowork
 *   descriptive `permissions` shape): not wrapped — the legacy trusted path.
 */
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { readJson } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import { PLUGIN_MANIFEST_CANDIDATES } from './plugin-manifest-candidates.js';
import {
  isLegacyCoworkPermissionsBlock,
  loadPluginPermissionPolicy,
  narrowPluginPermissions,
  parsePluginPermissionGrant,
  parsePluginPermissionRequest,
  type PluginFsMode,
  type PluginPermissionGrant,
} from './plugin-permissions.js';
import {
  getActiveSandboxPolicy,
  getPluginExecutionContext,
  intersectSandboxPolicies,
  pluginGrantNameMatches,
  SANDBOX_LOOPBACK_HOSTS,
  sandboxAllowlistEntryCovered,
  withPluginExecutionFrame,
  withSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js';

const logger = createLogger('plugin-grant');

export const EMPTY_PLUGIN_GRANT: PluginPermissionGrant = Object.freeze({
  network: Object.freeze({ mode: 'none', hosts: [] }),
  fs: Object.freeze({ mode: 'none', paths: [] }),
  ops_invoke: [],
  env: [],
  secrets: [],
}) as unknown as PluginPermissionGrant;

/** Tier-relative grant path -> absolute root (`knowledge/{tier}/{prefix}`). */
export function resolvePluginGrantPathRoot(tier: string, prefix: string): string {
  return pathResolver.rootResolve(path.posix.join('knowledge', tier, prefix));
}

/** Projects a grant onto the sandbox model (before intersection with the outer policy). */
export function pluginGrantSandboxPolicy(grant: PluginPermissionGrant): SandboxPolicy {
  const writable = grant.fs.mode === 'readwrite' && grant.fs.paths.length > 0;
  const hosts =
    grant.network.mode === 'loopback'
      ? [...SANDBOX_LOOPBACK_HOSTS]
      : grant.network.mode === 'allowlist'
        ? [...grant.network.hosts]
        : [];
  return {
    mode: writable ? 'workspace-write' : 'read-only',
    networkAccess: hosts.length > 0,
    ...(writable
      ? {
          writableRoots: grant.fs.paths.map((entry) =>
            resolvePluginGrantPathRoot(entry.tier, entry.prefix)
          ),
        }
      : {}),
    ...(hosts.length > 0 ? { networkAllowlist: hosts } : {}),
    provider: 'kyberion',
    enforcement: 'full',
    enforcement_reason: 'plugin permission grant (cooperative in-process mediation)',
  };
}

/**
 * Runs `fn` with the intersection of the active sandbox policy and `grant`,
 * inside a plugin execution frame. Never widens the enclosing policy.
 */
export function runWithPluginGrant<T>(
  grant: PluginPermissionGrant,
  pluginId: string,
  fn: () => T
): T {
  const policy = intersectSandboxPolicies(
    getActiveSandboxPolicy(),
    pluginGrantSandboxPolicy(grant)
  );
  return withSandboxPolicy(policy, () => withPluginExecutionFrame({ pluginId, grant }, fn));
}

/**
 * Cooperative env view for the executing plugin: only variables granted by
 * EVERY enclosing plugin frame. `process.env` itself is not blocked.
 * Outside a plugin frame this returns an empty object.
 */
export function getPluginEnv(): Record<string, string> {
  const context = getPluginExecutionContext();
  if (!context) return {};
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (context.chain.every((frame) => pluginGrantNameMatches(key, frame.grant.env))) {
      view[key] = value;
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// Grant comparison (used by the lifecycle ladder)
// ---------------------------------------------------------------------------

const FS_ORDER: PluginFsMode[] = ['none', 'readonly', 'readwrite'];

function networkHosts(grant: PluginPermissionGrant): string[] {
  if (grant.network.mode === 'loopback') return [...SANDBOX_LOOPBACK_HOSTS];
  if (grant.network.mode === 'allowlist') return grant.network.hosts;
  return [];
}

function namePatternCovered(inner: string, outer: string): boolean {
  if (outer === '*') return true;
  if (outer.endsWith('*')) {
    const bare = inner.endsWith('*') ? inner.slice(0, -1) : inner;
    return bare.startsWith(outer.slice(0, -1));
  }
  return inner === outer;
}

function prefixContains(outer: string, inner: string): boolean {
  return outer === '' || inner === outer || inner.startsWith(`${outer}/`);
}

/** True when `inner` grants nothing that `outer` does not (null outer = unrestricted). */
export function isPluginGrantWithin(
  inner: PluginPermissionGrant | null,
  outer: PluginPermissionGrant | null
): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  const hostsOk = networkHosts(inner).every((host) =>
    networkHosts(outer).some((allowed) => sandboxAllowlistEntryCovered(host, allowed))
  );
  const fsOk =
    inner.fs.mode === 'none' ||
    (FS_ORDER.indexOf(inner.fs.mode) <= FS_ORDER.indexOf(outer.fs.mode) &&
      inner.fs.paths.every((entry) =>
        outer.fs.paths.some(
          (allowed) => allowed.tier === entry.tier && prefixContains(allowed.prefix, entry.prefix)
        )
      ));
  const namesOk = (['ops_invoke', 'env', 'secrets'] as const).every((capability) =>
    inner[capability].every((name) =>
      outer[capability].some((allowed) => namePatternCovered(name, allowed))
    )
  );
  return hostsOk && fsOk && namesOk;
}

// ---------------------------------------------------------------------------
// Binding: one mutable grant holder per activation
// ---------------------------------------------------------------------------

export interface PluginGrantBinding {
  readonly pluginId: string;
  /** null = legacy official plugin without an EP-02 declaration (not wrapped). */
  readonly grant: PluginPermissionGrant | null;
  /** Narrow-only replacement (config_apply); throws when `next` would widen. */
  narrow(next: PluginPermissionGrant): void;
  run<T>(fn: () => T): T;
  /**
   * The call and everything it hands back run under the grant: returned
   * functions and classes (incl. `new`), (async) iterators, promise results
   * and objects with methods or getters are wrapped recursively (lazily, on
   * access); arrays, Map and Set that carry executables are returned as
   * wrapped copies (pure data is returned as-is).
   */
  wrapFunction<F extends (...args: any[]) => any>(fn: F): F;
  /** Function-valued members, getters and their results run under the grant. */
  wrapObject<T>(value: T): T;
}

// Scan verdicts: 'exec' = carries executable members (or could not be proven
// otherwise within the caps); 'data' = pure data.
type ScanVerdict = 'exec' | 'data';

const MAX_PLAIN_SCAN_DEPTH = 4;
const MAX_PLAIN_SCAN_KEYS = 256;

// Built-in values that never expose plugin code through their data: typed
// arrays, buffers, dates, regexps and errors are returned as-is (proxying
// them breaks internal slots and structured cloning). Weak collections cannot
// be enumerated, so a caller can only reach entries it already holds.
function isOpaqueBuiltin(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Error
  );
}

function isPlainCollection(
  value: object
): value is unknown[] | Map<unknown, unknown> | Set<unknown> {
  const proto = Object.getPrototypeOf(value);
  return (
    (Array.isArray(value) && proto === Array.prototype) ||
    (value instanceof Map && proto === Map.prototype) ||
    (value instanceof Set && proto === Set.prototype)
  );
}

/**
 * Executable-verdict cache. 'exec' is always cached (over-wrapping later is
 * harmless); 'data' only for deeply frozen plain objects/arrays, which can
 * never gain an executable member. Mutable data is re-scanned on every
 * return so a closure inserted later cannot escape unwrapped.
 */
const scanCache = new WeakMap<object, ScanVerdict>();

function scanValue(
  value: object,
  depth: number,
  active: Set<object>
): { verdict: ScanVerdict; stable: boolean } {
  const cached = scanCache.get(value);
  if (cached) return { verdict: cached, stable: true };
  if (isOpaqueBuiltin(value)) return { verdict: 'data', stable: true };
  const definite = (): { verdict: ScanVerdict; stable: boolean } => {
    scanCache.set(value, 'exec');
    return { verdict: 'exec', stable: true };
  };
  // Cycles are data as far as this path is concerned; the enclosing scan decides.
  if (active.has(value)) return { verdict: 'data', stable: false };
  const collection = isPlainCollection(value);
  const proto = Object.getPrototypeOf(value);
  // Class instances, generators, iterators and collection subclasses carry
  // prototype methods.
  if (!collection && proto !== Object.prototype && proto !== null) return definite();
  if (depth >= MAX_PLAIN_SCAN_DEPTH) return { verdict: 'exec', stable: false };
  active.add(value);
  try {
    let stable = !(value instanceof Map) && !(value instanceof Set);
    const visit = (member: unknown): boolean => {
      if (typeof member === 'function') return true;
      if (member === null || typeof member !== 'object') return false;
      const inner = scanValue(member, depth + 1, active);
      if (!inner.stable) stable = false;
      return inner.verdict === 'exec';
    };
    if (value instanceof Map) {
      let found = false;
      Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
        if (!found && (visit(key) || visit(entry))) found = true;
      });
      if (found) return definite();
    } else if (value instanceof Set) {
      let found = false;
      Set.prototype.forEach.call(value, (entry: unknown) => {
        if (!found && visit(entry)) found = true;
      });
      if (found) return definite();
    } else {
      const keys = Reflect.ownKeys(value);
      // Arrays are scanned in full (their elements are usually primitives).
      if (!Array.isArray(value) && keys.length > MAX_PLAIN_SCAN_KEYS) {
        return { verdict: 'exec', stable: false };
      }
      for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        if (!('value' in descriptor)) return definite();
        if (visit(descriptor.value)) return definite();
      }
    }
    if (stable && Object.isFrozen(value)) {
      scanCache.set(value, 'data');
      return { verdict: 'data', stable: true };
    }
    return { verdict: 'data', stable: false };
  } finally {
    active.delete(value);
  }
}

/**
 * Plain data (objects, arrays, Map, Set) is only wrapped when it
 * (transitively) carries executable members, so pure data results stay
 * cloneable. Class instances, generators and iterators always carry
 * prototype methods.
 */
function carriesExecutable(value: object): boolean {
  return scanValue(value, 0, new Set()).verdict === 'exec';
}

export function createPluginGrantBinding(
  pluginId: string,
  initial: PluginPermissionGrant | null
): PluginGrantBinding {
  let current = initial === null ? null : parsePluginPermissionGrant(initial);
  // Legacy (undeclared official) plugins are not wrapped at all: identity is
  // preserved and a later narrow() requires a reload instead.
  const legacy = current === null;
  const run = <T>(fn: () => T): T =>
    current === null ? fn() : runWithPluginGrant(current, pluginId, fn);

  const wrappedFunctions = new WeakMap<Function, Function>();
  const proxies = new WeakMap<object, object>();
  const produced = new WeakSet<object>();

  /**
   * Proxy over the plugin function itself so `name`, `length`, statics,
   * `prototype` and `instanceof` keep working. Calls and `new` run inside the
   * grant; `receiver` pins `this` for methods read through an object wrapper.
   * `prototype` is returned raw: instances report the raw prototype and a
   * class `prototype` is non-writable, so a wrapped one would break
   * `instanceof` and the Proxy invariants.
   */
  const callableProxy = (
    fn: Function,
    method?: { receiver: object; self: () => object }
  ): Function => {
    const proxy: Function = new Proxy(fn, {
      apply: (target, thisArg, args) => {
        const result: unknown = run(() =>
          Reflect.apply(target, method ? method.receiver : thisArg, args)
        );
        // Fluent / iterator-protocol methods returning the target keep the wrapper.
        return method && result === method.receiver ? method.self() : wrapResult(result);
      },
      construct: (target, args, newTarget) =>
        wrapResult(
          run(() => Reflect.construct(target, args, newTarget === proxy ? target : newTarget))
        ) as object,
      get: (target, property) => {
        const value: unknown = run(() => Reflect.get(target, property, target));
        if (property === 'prototype') return value;
        const own = Reflect.getOwnPropertyDescriptor(target, property);
        if (own && !own.configurable && 'value' in own && !own.writable) return value;
        return wrapResult(value);
      },
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (!descriptor || !descriptor.configurable || !('value' in descriptor)) return descriptor;
        return property === 'prototype'
          ? descriptor
          : { ...descriptor, value: wrapResult(descriptor.value) };
      },
    });
    produced.add(proxy);
    return proxy;
  };

  const wrapCallable = (fn: Function): Function => {
    if (produced.has(fn)) return fn;
    const cached = wrappedFunctions.get(fn);
    if (cached) return cached;
    const wrapped = callableProxy(fn);
    wrappedFunctions.set(fn, wrapped);
    return wrapped;
  };

  const wrapTarget = (target: object): object => {
    if (produced.has(target)) return target;
    const cached = proxies.get(target);
    if (cached) return cached;
    const methods = new Map<PropertyKey, { member: Function; bound: Function }>();
    const readMember = (property: PropertyKey): unknown => {
      // Getters are plugin code too.
      const member: unknown = run(() => Reflect.get(target, property, target));
      if (typeof member !== 'function') return wrapResult(member);
      const known = methods.get(property);
      if (known && known.member === member) return known.bound;
      const bound = callableProxy(member, { receiver: target, self: () => proxy });
      methods.set(property, { member, bound });
      return bound;
    };

    // The shadow keeps Proxy invariants satisfiable. It stays empty and
    // extensible until the plugin object gains non-configurable properties
    // or becomes non-extensible; those are mirrored (with wrapped values) so
    // Object.freeze / defineProperty / isFrozen behave as on the target.
    const shadow: object = Object.create(null);
    const accessors = new Map<PropertyKey, { get: () => unknown; set: (v: unknown) => void }>();
    const accessorOf = (property: PropertyKey) => {
      let known = accessors.get(property);
      if (!known) {
        known = {
          get: () => readMember(property),
          set: (value: unknown) => {
            run(() => Reflect.set(target, property, value, target));
          },
        };
        accessors.set(property, known);
      }
      return known;
    };
    const reported = (property: PropertyKey, descriptor: PropertyDescriptor): PropertyDescriptor =>
      'value' in descriptor
        ? {
            value: readMember(property),
            writable: descriptor.writable,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
          }
        : {
            get: accessorOf(property).get,
            ...(descriptor.set ? { set: accessorOf(property).set } : {}),
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
          };
    const mirror = (property: PropertyKey): PropertyDescriptor | undefined => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor) {
        Reflect.deleteProperty(shadow, property);
        return undefined;
      }
      if (descriptor.configurable && Reflect.isExtensible(shadow)) {
        Reflect.deleteProperty(shadow, property);
        return { ...reported(property, descriptor), configurable: true };
      }
      Reflect.defineProperty(shadow, property, reported(property, descriptor));
      return Reflect.getOwnPropertyDescriptor(shadow, property);
    };
    const sealShadow = (): void => {
      if (!Reflect.isExtensible(shadow) || Reflect.isExtensible(target)) return;
      Reflect.setPrototypeOf(shadow, Reflect.getPrototypeOf(target));
      for (const key of Reflect.ownKeys(target)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor) Reflect.defineProperty(shadow, key, reported(key, descriptor));
      }
      Reflect.preventExtensions(shadow);
    };
    const reconcile = (): void => {
      if (Reflect.isExtensible(shadow)) return;
      for (const key of Reflect.ownKeys(shadow)) {
        if (!Reflect.getOwnPropertyDescriptor(target, key)) Reflect.deleteProperty(shadow, key);
      }
    };

    const proxy: object = new Proxy(shadow, {
      get: (_shadow, property) => {
        const pinned = Reflect.getOwnPropertyDescriptor(shadow, property);
        if (pinned && !pinned.configurable && 'value' in pinned && !pinned.writable) {
          return pinned.value;
        }
        return readMember(property);
      },
      set: (_shadow, property, value) => run(() => Reflect.set(target, property, value, target)),
      has: (_shadow, property) => {
        const present = Reflect.has(target, property);
        if (!present) Reflect.deleteProperty(shadow, property);
        return present;
      },
      ownKeys: () => {
        reconcile();
        return Reflect.ownKeys(target);
      },
      deleteProperty: (_shadow, property) => {
        const deleted = Reflect.deleteProperty(target, property);
        if (deleted) Reflect.deleteProperty(shadow, property);
        return deleted;
      },
      defineProperty: (_shadow, property, descriptor) => {
        const defined = Reflect.defineProperty(target, property, descriptor);
        if (defined && !Reflect.getOwnPropertyDescriptor(target, property)?.configurable) {
          mirror(property);
        }
        return defined;
      },
      preventExtensions: () => {
        const prevented = Reflect.preventExtensions(target);
        if (prevented) sealShadow();
        return prevented;
      },
      isExtensible: () => {
        sealShadow();
        return Reflect.isExtensible(shadow);
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
      setPrototypeOf: (_shadow, prototype) => {
        const updated = Reflect.setPrototypeOf(target, prototype);
        if (updated && !Reflect.isExtensible(shadow)) Reflect.setPrototypeOf(shadow, prototype);
        return updated;
      },
      getOwnPropertyDescriptor: (_shadow, property) => mirror(property),
    });
    proxies.set(target, proxy);
    produced.add(proxy);
    return proxy;
  };

  /** Arrays, Map and Set carrying executables are returned as wrapped copies. */
  const copyCollection = (
    value: unknown[] | Map<unknown, unknown> | Set<unknown>,
    seen: Map<object, object>
  ): object => {
    if (value instanceof Map) {
      const copy = new Map<unknown, unknown>();
      seen.set(value, copy);
      Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
        copy.set(wrapResult(key, seen), wrapResult(entry, seen));
      });
      return copy;
    }
    if (value instanceof Set) {
      const copy = new Set<unknown>();
      seen.set(value, copy);
      Set.prototype.forEach.call(value, (entry: unknown) => {
        copy.add(wrapResult(entry, seen));
      });
      return copy;
    }
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      const item: unknown =
        'value' in descriptor ? descriptor.value : run(() => Reflect.get(value, key, value));
      Reflect.defineProperty(copy, key, {
        value: wrapResult(item, seen),
        writable: true,
        enumerable: descriptor.enumerable,
        configurable: true,
      });
    }
    return copy;
  };

  function wrapResult(value: unknown, seen?: Map<object, object>): unknown {
    if (legacy) return value;
    if (typeof value === 'function') return wrapCallable(value);
    if (value === null || typeof value !== 'object') return value;
    if (produced.has(value)) return value;
    if (value instanceof Promise) return value.then((resolved: unknown) => wrapResult(resolved));
    const copied = seen?.get(value);
    if (copied) return copied;
    // Scanning and copying may hit plugin-defined proxy traps or getters;
    // they run under the grant.
    return run(() => {
      if (!carriesExecutable(value)) return value;
      if (isPlainCollection(value)) {
        const copy = copyCollection(value, seen ?? new Map());
        produced.add(copy);
        return copy;
      }
      return wrapTarget(value);
    });
  }

  const wrapFunction = <F extends (...args: any[]) => any>(fn: F): F =>
    legacy ? fn : (wrapCallable(fn) as F);

  return {
    pluginId,
    get grant() {
      return current;
    },
    narrow(next) {
      if (legacy) {
        throw new Error(
          `[PLUGIN_GRANT_RELOAD_REQUIRED] plugin '${pluginId}' runs unwrapped (legacy); applying a grant requires a reload`
        );
      }
      const parsed = parsePluginPermissionGrant(next);
      if (!isPluginGrantWithin(parsed, current)) {
        throw new Error(
          `[PLUGIN_GRANT_WIDEN_DENIED] plugin '${pluginId}' grant can only be narrowed in place; widening requires reload after approval`
        );
      }
      current = parsed;
    },
    run,
    wrapFunction,
    wrapObject<T>(value: T): T {
      if (legacy) return value;
      if (typeof value === 'function') return wrapCallable(value) as T;
      if (value === null || typeof value !== 'object') return value;
      return wrapTarget(value) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Grant resolution
// ---------------------------------------------------------------------------

export interface PluginGrantSubject {
  pluginId: string;
  sourcePath: string;
  trust: 'official' | 'third-party';
  /**
   * Caller-resolved grant. For third-party plugins `null`/absent never means
   * "unwrapped" — they fall back to the managed record, then the empty grant.
   */
  grant?: PluginPermissionGrant | null;
}

export type PluginGrantSource =
  | 'provided'
  | 'managed_record'
  | 'manifest_declaration'
  | 'undeclared_official'
  | 'deny_by_default';

export interface ResolvedPluginExecutionGrant {
  grant: PluginPermissionGrant | null;
  source: PluginGrantSource;
  reason: string;
}

/**
 * Locates the nearest plugin manifest above an entry path (mirrors the loader
 * walk). Managed installs never reach this: grant resolution uses their
 * record, whose manifest was read at the managed root at install.
 */
export function findPluginManifestFor(
  sourcePath: string
): { path: string; raw: Record<string, unknown> } | undefined {
  let cursor = path.dirname(path.resolve(sourcePath));
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
      const manifestPath = path.join(cursor, candidate);
      if (!safeExistsSync(manifestPath)) continue;
      const stat = safeLstat(manifestPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `[PLUGIN_MANIFEST_INVALID] manifest must be a regular file: ${manifestPath}`
        );
      }
      const raw = readJson<unknown>(manifestPath);
      if (!isRecord(raw)) throw new Error(`[PLUGIN_MANIFEST_INVALID] ${manifestPath}`);
      return { path: manifestPath, raw };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

/** An EP-02 declaration is any `permissions` value except absent or the legacy Cowork shape. */
export function hasEp02PermissionDeclaration(
  manifest: Record<string, unknown> | undefined
): boolean {
  const declared = manifest?.permissions;
  return declared !== undefined && declared !== null && !isLegacyCoworkPermissionsBlock(declared);
}

const undeclaredOfficialLogged = new Set<string>();

/**
 * Approved managed-install grant for a plugin entry path. Registered by
 * plugin-managed-install (which owns the records) so this module stays out of
 * the install/loader import cycle; unregistered means no managed grant, so
 * third-party plugins fall back to deny-by-default.
 */
export interface ManagedPluginGrantRecord {
  pluginId: string;
  /** Verified provenance trust of the managed install (official / curated / third-party). */
  trust?: string;
  manifest?: { raw: Record<string, unknown> } | null;
  grantedPermissions?: PluginPermissionGrant;
}
export type ManagedPluginGrantLookup = (
  sourcePath: string,
  managedRoot: string | undefined
) => ManagedPluginGrantRecord | undefined;

let managedPluginGrantLookup: ManagedPluginGrantLookup | undefined;

export function setManagedPluginGrantLookup(lookup: ManagedPluginGrantLookup | undefined): void {
  managedPluginGrantLookup = lookup;
}

function narrowOfficialDeclaration(manifest: Record<string, unknown>): PluginPermissionGrant {
  return narrowPluginPermissions(
    parsePluginPermissionRequest(manifest.permissions),
    loadPluginPermissionPolicy(),
    { trust: 'official' }
  ).granted;
}

/**
 * The execution grant of a managed install, shared by the skill path and the
 * lifecycle so both treat the same record identically. The managed copy lives
 * outside `plugins/`, so its path never reads as official: the record's
 * verified trust decides. Official without an EP-02 declaration => null
 * (unwrapped legacy path); official with one => its approved grant;
 * everything else => its approved grant or the empty grant.
 */
export function resolveManagedRecordExecutionGrant(
  record: ManagedPluginGrantRecord
): ResolvedPluginExecutionGrant {
  if (record.trust === 'official') {
    const raw = record.manifest?.raw;
    if (!hasEp02PermissionDeclaration(raw)) {
      return {
        grant: null,
        source: 'undeclared_official',
        reason: `official managed install '${record.pluginId}' without an EP-02 declaration (legacy trusted path)`,
      };
    }
    return {
      grant: parsePluginPermissionGrant(
        record.grantedPermissions ?? narrowOfficialDeclaration(raw as Record<string, unknown>)
      ),
      source: 'managed_record',
      reason: `approved grant of official managed install '${record.pluginId}'`,
    };
  }
  if (record.grantedPermissions) {
    return {
      grant: parsePluginPermissionGrant(record.grantedPermissions),
      source: 'managed_record',
      reason: `approved grant of managed install '${record.pluginId}'`,
    };
  }
  return {
    grant: EMPTY_PLUGIN_GRANT,
    source: 'deny_by_default',
    reason: `managed install '${record.pluginId}' has no approved permission grant`,
  };
}

function findManagedRecord(
  sourcePath: string,
  managedRoot: string | undefined
): ManagedPluginGrantRecord | undefined {
  return managedPluginGrantLookup?.(sourcePath, managedRoot);
}

/** Decides which grant (if any) wraps a plugin's contributions. Fails closed on any error. */
export function resolvePluginExecutionGrant(
  subject: PluginGrantSubject,
  options: { managedRoot?: string } = {}
): ResolvedPluginExecutionGrant {
  const deny = (reason: string): ResolvedPluginExecutionGrant => ({
    grant: EMPTY_PLUGIN_GRANT,
    source: 'deny_by_default',
    reason,
  });
  try {
    if (subject.trust !== 'official') {
      if (subject.grant) {
        return {
          grant: parsePluginPermissionGrant(subject.grant),
          source: 'provided',
          reason: 'caller-provided grant',
        };
      }
      const record = findManagedRecord(subject.sourcePath, options.managedRoot);
      if (record) return resolveManagedRecordExecutionGrant(record);
      return deny('no approved permission grant; third-party plugins are deny-by-default');
    }

    if (subject.grant !== undefined) {
      return subject.grant === null
        ? { grant: null, source: 'provided', reason: 'caller marked the official plugin legacy' }
        : {
            grant: parsePluginPermissionGrant(subject.grant),
            source: 'provided',
            reason: 'caller-provided grant',
          };
    }
    // A managed official install runs under its approved record (tenant
    // narrowing included, manifest read from the managed root at install),
    // never a grant re-derived from whatever manifest sits near the entry.
    const managed = findManagedRecord(subject.sourcePath, options.managedRoot);
    if (managed) return resolveManagedRecordExecutionGrant(managed);
    const manifest = findPluginManifestFor(subject.sourcePath);
    if (!hasEp02PermissionDeclaration(manifest?.raw)) {
      if (!undeclaredOfficialLogged.has(subject.pluginId)) {
        undeclaredOfficialLogged.add(subject.pluginId);
        logger.debug(
          `official plugin '${subject.pluginId}' has no EP-02 permissions declaration; running on the legacy trusted (unwrapped) path`
        );
      }
      return {
        grant: null,
        source: 'undeclared_official',
        reason: 'official plugin without an EP-02 declaration (legacy trusted path)',
      };
    }
    return {
      grant: narrowOfficialDeclaration(manifest!.raw),
      source: 'manifest_declaration',
      reason: 'official declaration narrowed against the official ceiling',
    };
  } catch (error) {
    return deny(
      `grant could not be resolved (${error instanceof Error ? error.message : String(error)})`
    );
  }
}
