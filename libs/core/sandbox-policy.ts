/**
 * DH-11: provider-neutral sandbox policy resolution.
 *
 * Permission presets describe intent; this module reports what the selected
 * provider can actually enforce. Callers that require a complete sandbox
 * must reject `partial` rather than treating a provider approximation as safe.
 */

import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginPermissionGrant } from './plugin-permissions.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxEnforcement = 'full' | 'partial';

export interface SandboxPolicyInput {
  mode: SandboxMode;
  networkAccess?: boolean;
  writableRoots?: readonly string[];
  provider?:
    'codex' | 'claude' | 'agy' | 'grok' | 'gemini' | 'cursor' | 'opencode' | 'devin' | 'kyberion';
}

export interface SandboxPolicy {
  mode: SandboxMode;
  networkAccess: boolean;
  writableRoots?: readonly string[];
  /**
   * EP-03: when present, network access is limited to these hosts (exact,
   * `*.domain` for subdomains, or `*`). Absent means no host restriction
   * beyond `networkAccess`.
   */
  networkAllowlist?: readonly string[];
  provider: SandboxPolicyInput['provider'];
  enforcement: SandboxEnforcement;
  enforcement_reason: string;
}

const sandboxPolicyStorage = new AsyncLocalStorage<SandboxPolicy>();

/** Return the policy governing the current operation, when one was installed. */
export function getActiveSandboxPolicy(): SandboxPolicy | undefined {
  return sandboxPolicyStorage.getStore();
}

/**
 * Install one resolved policy around an operation. Low-level guards consume
 * this context so ADF, secure-io, and egress do not each invent a second
 * sandbox decision. The context is async-safe and nested calls inherit it.
 */
export function withSandboxPolicy<T>(policy: SandboxPolicy, fn: () => T): T {
  return sandboxPolicyStorage.run(policy, fn);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** Apply the active policy to a local filesystem mutation. */
export function assertSandboxWriteAllowed(filePath: string): void {
  const policy = getActiveSandboxPolicy();
  if (!policy) return;
  if (policy.mode === 'read-only') {
    throw new Error(
      `[SANDBOX_WRITE_DENIED] ${policy.provider ?? 'unknown'} read-only sandbox denies writes: ${filePath}`
    );
  }
  if (
    policy.mode === 'workspace-write' &&
    policy.writableRoots?.length &&
    !policy.writableRoots.some((root) => isPathWithin(filePath, root))
  ) {
    throw new Error(
      `[SANDBOX_WRITE_DENIED] path is outside the active writable roots: ${filePath}`
    );
  }
}

/** Loopback host names a `loopback` network grant expands to. */
export const SANDBOX_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

/**
 * Local host normalisation (egress-policy's normalizeEgressHost cannot be
 * imported here: egress-policy already depends on this module). Unlike that
 * helper it keeps a leading `*.` so allowlist wildcards stay meaningful.
 */
export function normalizeSandboxHost(host: string): string {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = normalizeSandboxHost(new URL(url).hostname);
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** True when `host` is covered by one allowlist entry (exact, `*.domain`, or `*`). */
export function sandboxHostMatches(host: string, entry: string): boolean {
  const candidate = normalizeSandboxHost(host);
  const allowed = normalizeSandboxHost(entry);
  if (!candidate || !allowed) return false;
  if (allowed === '*') return true;
  if (allowed.startsWith('*.')) {
    const suffix = allowed.slice(1);
    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  }
  return candidate === allowed;
}

/** Apply the active policy to a network request before URL/domain checks. */
export function assertSandboxNetworkAllowed(url?: string): void {
  const policy = getActiveSandboxPolicy();
  if (!policy) return;
  if (!policy.networkAccess) {
    throw new Error(
      `[SANDBOX_NETWORK_DENIED] ${policy.provider ?? 'unknown'} sandbox denies network access${url ? `: ${url}` : ''}`
    );
  }
  if (policy.networkAllowlist) {
    // Fail closed: an allowlist cannot be checked without a parseable host.
    const host = hostFromUrl(url);
    if (!host || !policy.networkAllowlist.some((entry) => sandboxHostMatches(host, entry))) {
      throw new Error(
        `[SANDBOX_NETWORK_DENIED] host is outside the active network allowlist${url ? `: ${url}` : ''}`
      );
    }
  }
}

/** Host-level check for callers that already parsed the hostname (egress). */
export function isSandboxNetworkHostAllowed(host: string): boolean {
  const policy = getActiveSandboxPolicy();
  if (!policy) return true;
  if (!policy.networkAccess) return false;
  if (!policy.networkAllowlist) return true;
  return policy.networkAllowlist.some((entry) => sandboxHostMatches(host, entry));
}

const SANDBOX_MODE_STRENGTH: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

function intersectRoots(
  outer: readonly string[] | undefined,
  inner: readonly string[] | undefined
): string[] | undefined {
  if (!outer?.length) return inner?.length ? [...inner] : undefined;
  if (!inner?.length) return [...outer];
  const result = new Set<string>();
  for (const a of inner) {
    for (const b of outer) {
      if (isPathWithin(a, b)) result.add(path.resolve(a));
      else if (isPathWithin(b, a)) result.add(path.resolve(b));
    }
  }
  return [...result].sort();
}

/** True when every host matched by `entry` is also matched by `pattern`. */
export function sandboxAllowlistEntryCovered(entry: string, pattern: string): boolean {
  const candidate = normalizeSandboxHost(entry);
  const allowed = normalizeSandboxHost(pattern);
  if (!candidate || !allowed) return false;
  if (candidate === allowed || allowed === '*') return true;
  if (candidate === '*') return false;
  if (allowed.startsWith('*.')) {
    const suffix = allowed.slice(1);
    const bare = candidate.startsWith('*.') ? candidate.slice(1) : candidate;
    return bare.endsWith(suffix) && bare.length > suffix.length;
  }
  return false;
}

function intersectAllowlists(
  outer: readonly string[] | undefined,
  inner: readonly string[] | undefined
): string[] | undefined {
  if (!outer) return inner ? [...inner] : undefined;
  if (!inner) return [...outer];
  const result = new Set<string>();
  for (const a of inner) {
    for (const b of outer) {
      if (sandboxAllowlistEntryCovered(a, b)) result.add(normalizeSandboxHost(a));
      else if (sandboxAllowlistEntryCovered(b, a)) result.add(normalizeSandboxHost(b));
    }
  }
  return [...result].sort();
}

/**
 * EP-03: the policy that satisfies BOTH inputs. Never wider than `outer` on
 * any axis (mode, writable roots, network, allowlist); an empty write-root
 * intersection degrades to read-only and an empty allowlist to no network.
 * Without an outer policy the inner one is returned unchanged.
 */
export function intersectSandboxPolicies(
  outer: SandboxPolicy | undefined,
  inner: SandboxPolicy
): SandboxPolicy {
  if (!outer) return inner;
  let mode: SandboxMode =
    SANDBOX_MODE_STRENGTH[outer.mode] <= SANDBOX_MODE_STRENGTH[inner.mode]
      ? outer.mode
      : inner.mode;
  let writableRoots: string[] | undefined;
  if (mode === 'workspace-write') {
    // danger-full-access imposes no roots of its own.
    const outerRoots = outer.mode === 'workspace-write' ? outer.writableRoots : undefined;
    const innerRoots = inner.mode === 'workspace-write' ? inner.writableRoots : undefined;
    writableRoots = intersectRoots(outerRoots, innerRoots);
    const restricted = Boolean(outerRoots?.length) || Boolean(innerRoots?.length);
    if (restricted && (!writableRoots || writableRoots.length === 0)) {
      mode = 'read-only';
      writableRoots = undefined;
    }
  }
  let networkAccess = outer.networkAccess && inner.networkAccess;
  let networkAllowlist = networkAccess
    ? intersectAllowlists(outer.networkAllowlist, inner.networkAllowlist)
    : undefined;
  if (networkAllowlist && networkAllowlist.length === 0) {
    networkAccess = false;
    networkAllowlist = undefined;
  }
  const partial = outer.enforcement === 'partial' || inner.enforcement === 'partial';
  return {
    mode,
    networkAccess,
    ...(writableRoots ? { writableRoots } : {}),
    ...(networkAllowlist ? { networkAllowlist } : {}),
    provider: outer.provider,
    enforcement: partial ? 'partial' : 'full',
    enforcement_reason: partial
      ? outer.enforcement === 'partial'
        ? outer.enforcement_reason
        : inner.enforcement_reason
      : `${outer.enforcement_reason}; intersected with ${inner.enforcement_reason}`,
  };
}

// ---------------------------------------------------------------------------
// EP-03: plugin execution context
// ---------------------------------------------------------------------------

export interface PluginExecutionFrame {
  pluginId: string;
  grant: PluginPermissionGrant;
}

export interface PluginExecutionContext extends PluginExecutionFrame {
  /** Every enclosing plugin frame (outermost first); checks must pass all of them. */
  chain: readonly PluginExecutionFrame[];
}

export type PluginGrantCapability = 'ops_invoke' | 'secrets' | 'env';

export class PluginGrantDeniedError extends Error {
  readonly code = 'PLUGIN_GRANT_DENIED';
  constructor(
    readonly pluginId: string,
    readonly capability: PluginGrantCapability,
    readonly subject: string
  ) {
    super(`[PLUGIN_GRANT_DENIED] plugin '${pluginId}' is not granted ${capability} '${subject}'`);
    this.name = 'PluginGrantDeniedError';
  }
}

const pluginExecutionStorage = new AsyncLocalStorage<PluginExecutionContext>();

/** The plugin whose contribution is currently executing, if any. */
export function getPluginExecutionContext(): PluginExecutionContext | undefined {
  return pluginExecutionStorage.getStore();
}

/** Push one plugin frame; nested frames keep every enclosing grant in the chain. */
export function withPluginExecutionFrame<T>(frame: PluginExecutionFrame, fn: () => T): T {
  const parent = pluginExecutionStorage.getStore();
  const chain = [...(parent?.chain ?? []), frame];
  return pluginExecutionStorage.run({ ...frame, chain }, fn);
}

/** Grant name patterns: exact, `prefix*`, or `*`. */
export function pluginGrantNameMatches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    return pattern === name;
  });
}

/** Returns the first plugin frame that does not grant `name`, if any. */
export function findPluginGrantDenial(
  capability: PluginGrantCapability,
  name: string
): PluginExecutionFrame | undefined {
  const context = getPluginExecutionContext();
  if (!context) return undefined;
  return context.chain.find((frame) => !pluginGrantNameMatches(name, frame.grant[capability]));
}

/** Throws `PluginGrantDeniedError` when a plugin frame is active and does not grant `name`. */
export function assertPluginGrantAllows(capability: PluginGrantCapability, name: string): void {
  const denied = findPluginGrantDenial(capability, name);
  if (denied) throw new PluginGrantDeniedError(denied.pluginId, capability, name);
}

/** Resolve one canonical policy and its enforcement fact for all callers. */
export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const provider = input.provider ?? 'kyberion';
  const networkAccess = input.networkAccess ?? false;
  const writableRoots = input.writableRoots?.length ? [...input.writableRoots] : undefined;

  if (input.mode === 'danger-full-access') {
    return {
      mode: input.mode,
      networkAccess,
      ...(writableRoots ? { writableRoots } : {}),
      provider,
      enforcement: 'partial',
      enforcement_reason: 'danger-full-access intentionally bypasses the filesystem sandbox',
    };
  }

  if (provider === 'agy' && input.mode === 'read-only') {
    return {
      mode: input.mode,
      networkAccess,
      ...(writableRoots ? { writableRoots } : {}),
      provider,
      enforcement: 'partial',
      enforcement_reason: 'agy exposes a sandbox flag but no verified read-only filesystem mode',
    };
  }

  return {
    mode: input.mode,
    networkAccess,
    ...(writableRoots ? { writableRoots } : {}),
    provider,
    enforcement: 'full',
    enforcement_reason: 'provider exposes the requested sandbox mode',
  };
}

/** Fail closed when a caller cannot operate with an approximate policy. */
export function requireSandboxEnforcement(
  policy: SandboxPolicy,
  required: SandboxEnforcement = 'full'
): SandboxPolicy {
  if (required === 'full' && policy.enforcement !== 'full') {
    throw new Error(
      `[SANDBOX_POLICY_PARTIAL] ${policy.provider ?? 'unknown'} cannot fully enforce ${policy.mode}: ${policy.enforcement_reason}`
    );
  }
  return policy;
}

/** Project the canonical policy into the Codex app-server request shape. */
export function toCodexSandboxPolicy(policy: SandboxPolicy): Record<string, unknown> {
  if (policy.mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (policy.mode === 'read-only') {
    return { type: 'readOnly', networkAccess: policy.networkAccess };
  }
  return {
    type: 'workspaceWrite',
    ...(policy.writableRoots ? { writableRoots: [...policy.writableRoots] } : {}),
    networkAccess: policy.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
