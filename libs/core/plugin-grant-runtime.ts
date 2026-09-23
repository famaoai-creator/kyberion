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
  wrapFunction<F extends (...args: any[]) => any>(fn: F): F;
  /** Shallow: function-valued members run under the grant. */
  wrapObject<T>(value: T): T;
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
  const wrapFunction = <F extends (...args: any[]) => any>(fn: F): F =>
    legacy
      ? fn
      : (function wrapped(this: unknown, ...args: unknown[]) {
          return run(() => fn.apply(this, args));
        } as unknown as F);
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
      if (typeof value === 'function') return wrapFunction(value as any) as unknown as T;
      if (value === null || typeof value !== 'object') return value;
      return new Proxy(value as object, {
        get(target, property) {
          const member = Reflect.get(target, property, target);
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => run(() => member.apply(target, args));
        },
      }) as T;
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

const MANIFEST_CANDIDATES = ['plugin-manifest.json', 'plugin.json', '.claude-plugin/plugin.json'];

/** Locates the nearest plugin manifest above an entry path (mirrors the loader walk). */
export function findPluginManifestFor(
  sourcePath: string
): { path: string; raw: Record<string, unknown> } | undefined {
  let cursor = path.dirname(path.resolve(sourcePath));
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of MANIFEST_CANDIDATES) {
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
      if (record?.grantedPermissions) {
        return {
          grant: parsePluginPermissionGrant(record.grantedPermissions),
          source: 'managed_record',
          reason: `approved grant of managed install '${record.pluginId}'`,
        };
      }
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
    const { granted } = narrowPluginPermissions(
      parsePluginPermissionRequest(manifest!.raw.permissions),
      loadPluginPermissionPolicy(),
      { trust: 'official' }
    );
    return {
      grant: granted,
      source: 'manifest_declaration',
      reason: 'official declaration narrowed against the official ceiling',
    };
  } catch (error) {
    return deny(
      `grant could not be resolved (${error instanceof Error ? error.message : String(error)})`
    );
  }
}
