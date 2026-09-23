/**
 * EP-02: declared plugin permissions and approval-time narrowing.
 *
 * A plugin manifest may declare `permissions` (network / fs / ops_invoke /
 * env / secrets). An absent declaration means "nothing" — deny by default.
 * At install time the request is intersected with the governed per-trust
 * ceiling (`plugin-permission-policy.json`) and, when a tenant is known, with
 * that tenant's narrow-only override. The result is the grant a human
 * approves; it is never wider than either the request or any ceiling.
 *
 * Filesystem paths are tier-relative prefixes (`knowledge/{tier}/...`).
 * Confidential paths must stay inside the installing tenant's own
 * `knowledge/confidential/{tenant}/` scope — other tenants are always
 * denied, regardless of policy. Personal-tier paths are denied unless a
 * ceiling explicitly lists the personal tier.
 *
 * This module only computes and records grants; runtime enforcement is a
 * separate layer.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { pathResolver } from './path-resolver.js';
import type { PluginTrustLabel } from './plugin-source-trust.js';

/**
 * Seams a plugin may never provide: binding any of them would let plugin code
 * decide approvals, replace op resolution or move the governed clock.
 */
export const PLUGIN_RESERVED_SEAMS: readonly string[] = Object.freeze([
  'core-clock',
  'risky-approval-handler',
  'risky-approval-override',
  'scenario-op-override',
]);

/**
 * Seams only official-provenance plugins may provide: they resolve secrets,
 * identity context or receive the audit stream. Refused at install for
 * non-official packages and again at activation — fail closed.
 */
export const PLUGIN_OFFICIAL_ONLY_SEAMS: readonly string[] = Object.freeze([
  'audit-forwarder',
  'identity-context-resolver',
  'secret-resolver',
]);

/** The first declared official-only seam a plugin of `trust` may not provide. */
export function findDisallowedOfficialOnlySeam(
  seams: readonly unknown[] | undefined,
  trust: string
): string | undefined {
  if (trust === 'official') return undefined;
  return (seams ?? [])
    .map((seam) => String(seam).trim())
    .find((seam) => PLUGIN_OFFICIAL_ONLY_SEAMS.includes(seam));
}

export type PluginNetworkMode = 'none' | 'loopback' | 'allowlist';
export type PluginFsMode = 'none' | 'readonly' | 'readwrite';
export type PluginPermissionTier = 'public' | 'confidential' | 'personal';

export interface PluginFsPathScope {
  tier: PluginPermissionTier;
  /** Tier-relative prefix (`''` = the whole tier root). */
  prefix: string;
}

export interface PluginPermissionRequest {
  network: { mode: PluginNetworkMode; hosts?: string[] };
  fs: { mode: PluginFsMode; paths?: PluginFsPathScope[] };
  ops_invoke?: string[];
  env?: string[];
  secrets?: string[];
}

/** Fully resolved grant: every field present, arrays sorted and de-duplicated. */
export interface PluginPermissionGrant {
  network: { mode: PluginNetworkMode; hosts: string[] };
  fs: { mode: PluginFsMode; paths: PluginFsPathScope[] };
  ops_invoke: string[];
  env: string[];
  secrets: string[];
}

export interface PluginPermissionCeiling {
  /** `hosts` entries: exact host, `*.domain`, or `*` (any host). */
  network: { mode: PluginNetworkMode; hosts: string[]; allow_wildcard_hosts?: boolean };
  /** `prefix` may use the `{tenant}` segment, substituted with the installing tenant. */
  fs: { mode: PluginFsMode; paths: PluginFsPathScope[] };
  /** Entries: exact name, `prefix*`, or `*`. */
  ops_invoke: string[];
  env: string[];
  secrets: string[];
}

export interface PluginPermissionPolicy {
  version: string;
  last_updated: string;
  ceilings: Record<PluginTrustLabel, PluginPermissionCeiling>;
  /** Narrow-only: applied on top of the trust ceiling, never instead of it. */
  tenant_overrides: Record<
    string,
    { ceilings: Partial<Record<PluginTrustLabel, Partial<PluginPermissionCeiling>>> }
  >;
}

export type PluginPermissionCapability = 'network' | 'fs' | 'ops_invoke' | 'env' | 'secrets';

export interface PermissionDiffEntry {
  capability: PluginPermissionCapability;
  requested: string;
  ceiling: string;
  granted: string;
  narrowed: boolean;
}

export interface NarrowPluginPermissionsOptions {
  trust: PluginTrustLabel;
  tenantSlug?: string;
}

export interface NarrowPluginPermissionsResult {
  granted: PluginPermissionGrant;
  diff: PermissionDiffEntry[];
}

export const PLUGIN_PERMISSION_POLICY_RELATIVE_PATH =
  'knowledge/product/governance/plugin-permission-policy.json';

const CRITICAL_CAPABILITIES: PluginPermissionCapability[] = ['fs', 'network', 'secrets'];
const NETWORK_MODES: PluginNetworkMode[] = ['none', 'loopback', 'allowlist'];
const FS_MODES: PluginFsMode[] = ['none', 'readonly', 'readwrite'];
const TIERS: PluginPermissionTier[] = ['public', 'confidential', 'personal'];
const NAME_PATTERN = /^[A-Za-z0-9_.:/-]+\*?$|^\*$/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class PluginPermissionNarrowedError extends Error {
  readonly code = 'PLUGIN_PERMISSION_NARROWED';
  constructor(
    readonly capability: PluginPermissionCapability,
    readonly requested: string,
    readonly granted: string,
    readonly requiredElevation: string,
    readonly diff: PermissionDiffEntry[]
  ) {
    super(
      `[PLUGIN_PERMISSION_NARROWED] Requested ${capability} (${requested}) was narrowed to ${granted}. ${requiredElevation}`
    );
    this.name = 'PluginPermissionNarrowedError';
  }
}

/** Codepoint order — never localeCompare (cross-platform determinism). */
function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(codepointCompare);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): Error {
  return new Error(`[PLUGIN_PERMISSIONS_INVALID] ${message}`);
}

function assertKnownKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw invalid(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalid(`${label} must be an array of strings`);
  }
  return value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
}

function parseFsPaths(value: unknown, label: string): PluginFsPathScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`${label}[${index}] must be an object`);
    assertKnownKeys(entry, ['tier', 'prefix'], `${label}[${index}]`);
    if (!TIERS.includes(entry.tier as PluginPermissionTier)) {
      throw invalid(`${label}[${index}].tier must be one of ${TIERS.join(', ')}`);
    }
    if (typeof entry.prefix !== 'string')
      throw invalid(`${label}[${index}].prefix must be a string`);
    return { tier: entry.tier as PluginPermissionTier, prefix: entry.prefix };
  });
}

const LEGACY_COWORK_PERMISSION_KEYS = [
  'file_access',
  'network_access',
  'shell_exec',
  'tier_visibility',
  'risky_ops_require_approval',
];

/**
 * True for the Cowork v1 manifest `permissions` block (descriptive metadata
 * with a different shape). Callers treat it as "no EP-02 declaration", which
 * keeps the grant deny-by-default rather than guessing a mapping.
 */
export function isLegacyCoworkPermissionsBlock(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => LEGACY_COWORK_PERMISSION_KEYS.includes(key));
}

/**
 * Parses a manifest `permissions` block. Absent => everything none/empty.
 * Malformed declarations throw (callers treat that as a broken manifest).
 */
export function parsePluginPermissionRequest(value: unknown): PluginPermissionRequest {
  if (value === undefined || value === null) {
    return { network: { mode: 'none' }, fs: { mode: 'none' } };
  }
  if (!isPlainObject(value)) throw invalid('permissions must be an object');
  assertKnownKeys(value, ['network', 'fs', 'ops_invoke', 'env', 'secrets'], 'permissions');

  let network: PluginPermissionRequest['network'] = { mode: 'none' };
  if (value.network !== undefined) {
    if (!isPlainObject(value.network)) throw invalid('permissions.network must be an object');
    assertKnownKeys(value.network, ['mode', 'hosts'], 'permissions.network');
    if (!NETWORK_MODES.includes(value.network.mode as PluginNetworkMode)) {
      throw invalid(`permissions.network.mode must be one of ${NETWORK_MODES.join(', ')}`);
    }
    network = {
      mode: value.network.mode as PluginNetworkMode,
      hosts: parseStringArray(value.network.hosts, 'permissions.network.hosts'),
    };
  }

  let fs: PluginPermissionRequest['fs'] = { mode: 'none' };
  if (value.fs !== undefined) {
    if (!isPlainObject(value.fs)) throw invalid('permissions.fs must be an object');
    assertKnownKeys(value.fs, ['mode', 'paths'], 'permissions.fs');
    if (!FS_MODES.includes(value.fs.mode as PluginFsMode)) {
      throw invalid(`permissions.fs.mode must be one of ${FS_MODES.join(', ')}`);
    }
    fs = {
      mode: value.fs.mode as PluginFsMode,
      paths: parseFsPaths(value.fs.paths, 'permissions.fs.paths'),
    };
  }

  return {
    network,
    fs,
    ops_invoke: parseStringArray(value.ops_invoke, 'permissions.ops_invoke'),
    env: parseStringArray(value.env, 'permissions.env'),
    secrets: parseStringArray(value.secrets, 'permissions.secrets'),
  };
}

/**
 * Strictly parses a persisted grant (e.g. from a managed plugin record).
 * Returns the canonical form; throws on any structural deviation.
 */
export function parsePluginPermissionGrant(value: unknown): PluginPermissionGrant {
  if (!isPlainObject(value)) throw invalid('grant must be an object');
  assertKnownKeys(value, ['network', 'fs', 'ops_invoke', 'env', 'secrets'], 'grant');
  const request = parsePluginPermissionRequest(value);
  if (
    !isPlainObject(value.network) ||
    !Array.isArray(value.network.hosts) ||
    !isPlainObject(value.fs) ||
    !Array.isArray(value.fs.paths) ||
    !Array.isArray(value.ops_invoke) ||
    !Array.isArray(value.env) ||
    !Array.isArray(value.secrets)
  ) {
    throw invalid('grant must be fully resolved');
  }
  return canonicalGrant({
    network: { mode: request.network.mode, hosts: request.network.hosts ?? [] },
    fs: { mode: request.fs.mode, paths: request.fs.paths ?? [] },
    ops_invoke: request.ops_invoke ?? [],
    env: request.env ?? [],
    secrets: request.secrets ?? [],
  });
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeHost(raw: string, allowWildcard: boolean): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host === '*') return allowWildcard ? '*' : null;
  let labels = host.split('.');
  if (labels[0] === '*') {
    if (!allowWildcard) return null;
    labels = labels.slice(1);
    if (labels.length < 2) return null;
    return labels.every((label) => HOST_LABEL_PATTERN.test(label)) ? `*.${labels.join('.')}` : null;
  }
  return labels.every((label) => HOST_LABEL_PATTERN.test(label)) ? labels.join('.') : null;
}

function hostCovered(requested: string, ceiling: string): boolean {
  if (ceiling === '*' || requested === ceiling) return true;
  if (ceiling.startsWith('*.')) {
    const suffix = ceiling.slice(1); // ".example.com"
    const candidate = requested.startsWith('*.') ? requested.slice(1) : requested;
    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  }
  return !requested.startsWith('*') && requested === ceiling;
}

function nameCovered(requested: string, ceiling: string): boolean {
  if (ceiling === '*') return true;
  if (ceiling.endsWith('*')) {
    const prefix = ceiling.slice(0, -1);
    const candidate = requested.endsWith('*') ? requested.slice(0, -1) : requested;
    return candidate.startsWith(prefix);
  }
  return !requested.endsWith('*') && requested === ceiling;
}

/** Normalises a tier-relative prefix; returns null when it would escape the tier root. */
export function normalizeTierPrefix(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

function prefixContains(outer: string, inner: string): boolean {
  return outer === '' || inner === outer || inner.startsWith(`${outer}/`);
}

function isPathAllowedForScope(scope: PluginFsPathScope, tenantSlug: string | undefined): boolean {
  if (scope.tier !== 'confidential') return true;
  // Cross-tenant access is never grantable, whatever the policy says.
  return Boolean(tenantSlug) && scope.prefix !== '' && prefixContains(tenantSlug!, scope.prefix);
}

function resolveCeilingPaths(
  paths: PluginFsPathScope[],
  tenantSlug: string | undefined
): PluginFsPathScope[] {
  const resolved: PluginFsPathScope[] = [];
  for (const entry of paths) {
    const segments = entry.prefix.split('/');
    if (segments.includes('{tenant}') && !tenantSlug) continue;
    const substituted = segments.map((segment) =>
      segment === '{tenant}' ? (tenantSlug as string) : segment
    );
    if (substituted.some((segment) => segment.includes('{') || segment.includes('}'))) continue;
    const prefix = normalizeTierPrefix(substituted.join('/'));
    if (prefix === null) continue;
    resolved.push({ tier: entry.tier, prefix });
  }
  return resolved;
}

function comparePaths(a: PluginFsPathScope, b: PluginFsPathScope): number {
  return TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || codepointCompare(a.prefix, b.prefix);
}

/** Sorts and drops paths already covered by a broader path of the same tier. */
function compactPaths(paths: PluginFsPathScope[]): PluginFsPathScope[] {
  const sorted = [...paths].sort(comparePaths);
  const result: PluginFsPathScope[] = [];
  for (const candidate of sorted) {
    if (
      result.some(
        (existing) =>
          existing.tier === candidate.tier && prefixContains(existing.prefix, candidate.prefix)
      )
    ) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}

function canonicalGrant(grant: PluginPermissionGrant): PluginPermissionGrant {
  const hosts = grant.network.mode === 'allowlist' ? sortedUnique(grant.network.hosts) : [];
  const networkMode: PluginNetworkMode =
    grant.network.mode === 'allowlist' && hosts.length === 0 ? 'none' : grant.network.mode;
  const paths = grant.fs.mode === 'none' ? [] : compactPaths(grant.fs.paths);
  return {
    network: { mode: networkMode, hosts },
    fs: { mode: paths.length === 0 ? 'none' : grant.fs.mode, paths },
    ops_invoke: sortedUnique(grant.ops_invoke),
    env: sortedUnique(grant.env),
    secrets: sortedUnique(grant.secrets),
  };
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function narrowNetwork(
  request: PluginPermissionRequest['network'],
  ceiling: PluginPermissionCeiling['network']
): PluginPermissionGrant['network'] {
  if (request.mode === 'none' || ceiling.mode === 'none') return { mode: 'none', hosts: [] };
  if (request.mode === 'loopback') {
    // An allowlist ceiling implies loopback only when it allows any host.
    const loopbackAllowed =
      ceiling.mode === 'loopback' || (ceiling.mode === 'allowlist' && ceiling.hosts.includes('*'));
    return loopbackAllowed ? { mode: 'loopback', hosts: [] } : { mode: 'none', hosts: [] };
  }
  if (ceiling.mode !== 'allowlist') return { mode: 'none', hosts: [] };
  const allowWildcard = ceiling.allow_wildcard_hosts === true;
  const ceilingHosts = ceiling.hosts
    .map((host) => normalizeHost(host, true))
    .filter((host): host is string => host !== null);
  const hosts = (request.hosts ?? [])
    .map((host) => normalizeHost(host, allowWildcard))
    .filter((host): host is string => host !== null)
    .filter((host) => ceilingHosts.some((allowed) => hostCovered(host, allowed)));
  return hosts.length > 0
    ? { mode: 'allowlist', hosts: sortedUnique(hosts) }
    : { mode: 'none', hosts: [] };
}

function narrowFs(
  request: PluginPermissionRequest['fs'],
  ceiling: PluginPermissionCeiling['fs'],
  tenantSlug: string | undefined
): PluginPermissionGrant['fs'] {
  const mode = FS_MODES[Math.min(FS_MODES.indexOf(request.mode), FS_MODES.indexOf(ceiling.mode))];
  if (mode === 'none') return { mode: 'none', paths: [] };
  const ceilingPaths = resolveCeilingPaths(ceiling.paths, tenantSlug);
  const granted: PluginFsPathScope[] = [];
  for (const requested of request.paths ?? []) {
    const prefix = normalizeTierPrefix(requested.prefix);
    if (prefix === null) continue;
    for (const allowed of ceilingPaths) {
      if (allowed.tier !== requested.tier) continue;
      let intersection: string | null = null;
      if (prefixContains(allowed.prefix, prefix)) intersection = prefix;
      else if (prefixContains(prefix, allowed.prefix)) intersection = allowed.prefix;
      if (intersection === null) continue;
      const scope = { tier: requested.tier, prefix: intersection };
      if (isPathAllowedForScope(scope, tenantSlug)) granted.push(scope);
    }
  }
  const paths = compactPaths(granted);
  return paths.length > 0 ? { mode, paths } : { mode: 'none', paths: [] };
}

function narrowNames(requested: string[] | undefined, ceiling: string[]): string[] {
  const validCeiling = ceiling.filter((entry) => NAME_PATTERN.test(entry));
  return sortedUnique(
    (requested ?? [])
      .filter((entry) => NAME_PATTERN.test(entry))
      .filter((entry) => validCeiling.some((allowed) => nameCovered(entry, allowed)))
  );
}

function intersect(
  request: PluginPermissionRequest,
  ceiling: Partial<PluginPermissionCeiling>,
  tenantSlug: string | undefined
): PluginPermissionGrant {
  const passthrough = grantFromRequestUnchecked(request);
  return canonicalGrant({
    network: ceiling.network
      ? narrowNetwork(request.network, ceiling.network)
      : passthrough.network,
    fs: ceiling.fs ? narrowFs(request.fs, ceiling.fs, tenantSlug) : passthrough.fs,
    ops_invoke: ceiling.ops_invoke
      ? narrowNames(request.ops_invoke, ceiling.ops_invoke)
      : passthrough.ops_invoke,
    env: ceiling.env ? narrowNames(request.env, ceiling.env) : passthrough.env,
    secrets: ceiling.secrets ? narrowNames(request.secrets, ceiling.secrets) : passthrough.secrets,
  });
}

function grantFromRequestUnchecked(request: PluginPermissionRequest): PluginPermissionGrant {
  return {
    network: { mode: request.network.mode, hosts: request.network.hosts ?? [] },
    fs: { mode: request.fs.mode, paths: request.fs.paths ?? [] },
    ops_invoke: request.ops_invoke ?? [],
    env: request.env ?? [],
    secrets: request.secrets ?? [],
  };
}

const DENY_ALL_CEILING: PluginPermissionCeiling = {
  network: { mode: 'none', hosts: [] },
  fs: { mode: 'none', paths: [] },
  ops_invoke: [],
  env: [],
  secrets: [],
};

function describeList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : 'none';
}

function describeNetwork(network: { mode: PluginNetworkMode; hosts?: string[] }): string {
  if (network.mode !== 'allowlist') return network.mode;
  return `allowlist [${(network.hosts ?? []).join(', ')}]`;
}

function describeFs(fs: { mode: PluginFsMode; paths?: PluginFsPathScope[] }): string {
  if (fs.mode === 'none') return 'none';
  const paths = (fs.paths ?? []).map((entry) => `${entry.tier}:${entry.prefix || '*'}`);
  return `${fs.mode} [${paths.join(', ')}]`;
}

function describeCapability(
  capability: PluginPermissionCapability,
  value: Partial<PluginPermissionRequest> | Partial<PluginPermissionCeiling>
): string | undefined {
  switch (capability) {
    case 'network':
      return value.network ? describeNetwork(value.network) : undefined;
    case 'fs':
      return value.fs ? describeFs(value.fs) : undefined;
    default:
      return value[capability] ? describeList(value[capability]) : undefined;
  }
}

function describeGrantCapability(
  capability: PluginPermissionCapability,
  grant: PluginPermissionGrant
): string {
  return describeCapability(capability, grant) as string;
}

function capabilityRequested(
  capability: PluginPermissionCapability,
  request: PluginPermissionRequest
): boolean {
  if (capability === 'network') return request.network.mode !== 'none';
  if (capability === 'fs') return request.fs.mode !== 'none';
  return (request[capability] ?? []).length > 0;
}

function capabilityEmpty(
  capability: PluginPermissionCapability,
  grant: PluginPermissionGrant
): boolean {
  if (capability === 'network') return grant.network.mode === 'none';
  if (capability === 'fs') return grant.fs.mode === 'none';
  return grant[capability].length === 0;
}

function requiredElevationText(
  capability: PluginPermissionCapability,
  requested: string,
  request: PluginPermissionRequest,
  options: NarrowPluginPermissionsOptions
): string {
  const where = `ceilings.${options.trust}.${capability} in ${PLUGIN_PERMISSION_POLICY_RELATIVE_PATH}`;
  const overrideNote = options.tenantSlug
    ? ` (and any tenant_overrides.${options.tenantSlug} narrowing)`
    : '';
  const lines = [
    `Required elevation: trust level '${options.trust}' must be allowed ${capability} ${requested} — raise ${where}${overrideNote}, or install the plugin from a higher-trust source.`,
  ];
  if (capability === 'fs') {
    const paths = request.fs.paths ?? [];
    if (paths.some((entry) => entry.tier === 'confidential')) {
      lines.push(
        options.tenantSlug
          ? `Confidential paths must stay inside knowledge/confidential/${options.tenantSlug}/; other tenants' scopes are never grantable.`
          : "Confidential paths require an installing tenant (--tenant) and must stay inside that tenant's knowledge/confidential/{tenant}/ scope."
      );
    }
    if (paths.some((entry) => entry.tier === 'personal')) {
      lines.push('The personal tier is denied unless the policy ceiling explicitly lists it.');
    }
    if (paths.length === 0) {
      lines.push('The manifest requested filesystem access without declaring any fs.paths.');
    }
  }
  return lines.join(' ');
}

/**
 * Pure intersection of the request with the trust ceiling and (when a
 * tenant is given) its narrow-only override. Never widens. Throws
 * `PluginPermissionNarrowedError` when a requested critical capability
 * (fs / network / secrets) is narrowed to nothing.
 */
export function narrowPluginPermissions(
  request: PluginPermissionRequest,
  policy: PluginPermissionPolicy,
  options: NarrowPluginPermissionsOptions
): NarrowPluginPermissionsResult {
  const tenantSlug =
    options.tenantSlug && isValidTenantSlug(options.tenantSlug) ? options.tenantSlug : undefined;
  const base = policy.ceilings?.[options.trust] ?? DENY_ALL_CEILING;
  let granted = intersect(request, base, tenantSlug);
  const override = tenantSlug
    ? policy.tenant_overrides?.[tenantSlug]?.ceilings?.[options.trust]
    : undefined;
  if (override) {
    granted = intersect(granted, override, tenantSlug);
  }

  const capabilities: PluginPermissionCapability[] = [
    'network',
    'fs',
    'ops_invoke',
    'env',
    'secrets',
  ];
  const diff: PermissionDiffEntry[] = capabilities.map((capability) => {
    const requested = describeCapability(capability, request) ?? 'none';
    const baseCeiling = describeCapability(capability, base) ?? 'none';
    const overrideCeiling = override ? describeCapability(capability, override) : undefined;
    const grantedText = describeGrantCapability(capability, granted);
    return {
      capability,
      requested,
      ceiling: overrideCeiling
        ? `${baseCeiling} + tenant ${tenantSlug}: ${overrideCeiling}`
        : baseCeiling,
      granted: grantedText,
      narrowed: requested !== grantedText,
    };
  });

  for (const capability of CRITICAL_CAPABILITIES) {
    if (capabilityRequested(capability, request) && capabilityEmpty(capability, granted)) {
      const entry = diff.find((candidate) => candidate.capability === capability)!;
      throw new PluginPermissionNarrowedError(
        capability,
        entry.requested,
        entry.granted,
        requiredElevationText(capability, entry.requested, request, {
          trust: options.trust,
          tenantSlug,
        }),
        diff
      );
    }
  }

  return { granted, diff };
}

/** Stable sha256 over the canonical grant. */
export function permissionsDigest(grant: PluginPermissionGrant): string {
  const canonical = canonicalGrant(grant);
  const ordered = {
    network: { mode: canonical.network.mode, hosts: canonical.network.hosts },
    fs: {
      mode: canonical.fs.mode,
      paths: canonical.fs.paths.map((entry) => ({ tier: entry.tier, prefix: entry.prefix })),
    },
    ops_invoke: canonical.ops_invoke,
    env: canonical.env,
    secrets: canonical.secrets,
  };
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

export function formatPermissionDiffTable(diff: PermissionDiffEntry[]): string {
  const header = ['capability', 'requested', 'ceiling', 'granted', 'narrowed'];
  const rows = diff.map((entry) => [
    entry.capability,
    entry.requested,
    entry.ceiling,
    entry.granted,
    entry.narrowed ? 'yes' : 'no',
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length))
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join(' | ')
      .trimEnd();
  return [
    render(header),
    widths.map((width) => '-'.repeat(width)).join('-+-'),
    ...rows.map(render),
  ].join('\n');
}

export function summarizePermissionDiff(diff: PermissionDiffEntry[]): string {
  return diff
    .map(
      (entry) =>
        `${entry.capability}=${entry.granted}${entry.narrowed ? ` (requested ${entry.requested})` : ''}`
    )
    .join('; ');
}

const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/plugin-permission-policy.schema.json'
);
const policyCatalogs = new Map<string, GovernedCatalog<PluginPermissionPolicy>>();

/** Loads the governed plugin permission policy (schema-validated, secure-io). */
export function loadPluginPermissionPolicy(policyPath?: string): PluginPermissionPolicy {
  const resolved = policyPath
    ? path.resolve(policyPath)
    : pathResolver.rootResolve(PLUGIN_PERMISSION_POLICY_RELATIVE_PATH);
  let catalog = policyCatalogs.get(resolved);
  if (!catalog) {
    catalog = defineCatalog<PluginPermissionPolicy>({
      id: 'plugin-permission-policy',
      path: resolved,
      schema: POLICY_SCHEMA_PATH,
    });
    policyCatalogs.set(resolved, catalog);
  }
  return catalog.load();
}
