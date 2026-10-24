/** Content-bound memory lineage. Evidence eligibility never grants execution authority. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveRole, withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import {
  MEMORY_PROVENANCE_READER_ROLE,
  memoryProvenanceStatePath,
  withMemoryProvenanceReadCapability,
} from './memory-provenance-capability.js';
import { KNOWLEDGE_TIER_RANK } from '../foundation/knowledge-tier.js';
import { detectTier } from '../tier-guard.js';
import { readTextFile } from '../foundation/text.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { writeJson } from '../foundation/json.js';
import { safeExistsSync, assertSafeRepositoryPath } from '../secure-io.js';
import {
  assertMemoryScope,
  memoryScopeAllowsRead,
  type MemoryScopeEnvelope,
} from './memory-scope.js';
import type { ScopeContext } from '../scope-context.js';

export interface MemoryOriginRef {
  source_id: string;
  generation: number;
  sha256: string;
}
export interface MemoryProvenanceRecord extends MemoryOriginRef {
  kind?: 'external';
  document_path: string;
  scope: MemoryScopeEnvelope;
  source_families: string[];
  origins: MemoryOriginRef[];
  revoked: boolean;
  reason?: string;
  unverified_refs?: string[];
}
interface MemoryProvenanceState {
  version: 1;
  records: Record<string, MemoryProvenanceRecord>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validOrigin(value: unknown): value is MemoryOriginRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as MemoryOriginRef;
  return (
    isHash(origin.source_id) &&
    isHash(origin.sha256) &&
    Number.isSafeInteger(origin.generation) &&
    origin.generation >= 0
  );
}
const scopeKey = (scope: MemoryScopeEnvelope) => JSON.stringify(assertMemoryScope(scope));
/** Source identity follows durable tenant/owner partition, not a particular use context. */
function partitionScope(scope: MemoryScopeEnvelope): MemoryScopeEnvelope {
  return {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.tier === 'personal' && scope.owner_nhi ? { owner_nhi: scope.owner_nhi } : {}),
  };
}
const partitionKey = (scope: MemoryScopeEnvelope) => scopeKey(partitionScope(scope));
function scopeCanNarrow(source: MemoryScopeEnvelope, target: MemoryScopeEnvelope): boolean {
  if (partitionKey(source) !== partitionKey(target)) return false;
  for (const key of [
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ] as const)
    if (source[key] && source[key] !== target[key]) return false;
  return (
    !source.allowed_audience?.length ||
    (!!target.allowed_audience?.length &&
      target.allowed_audience.every((principal) => source.allowed_audience!.includes(principal)))
  );
}
const pathIndexes = new WeakMap<MemoryProvenanceState, Map<string, MemoryProvenanceRecord[]>>();
function recordsAtPath(state: MemoryProvenanceState, file: string): MemoryProvenanceRecord[] {
  let index = pathIndexes.get(state);
  if (!index) {
    index = new Map();
    for (const record of Object.values(state.records)) {
      const group = index.get(record.document_path) || [];
      group.push(record);
      index.set(record.document_path, group);
    }
    pathIndexes.set(state, index);
  }
  return index.get(file) || [];
}

/** Same durable memory partition as the queue, deliberately outside mission/checkpoint files. */
const statePath = (scope: MemoryScopeEnvelope) =>
  memoryProvenanceStatePath(assertMemoryScope(scope));
function load(scope: MemoryScopeEnvelope): MemoryProvenanceState {
  const file = statePath(scope);
  const read = () =>
    safeExistsSync(pathResolver.rootResolve(file))
      ? readTextFile(pathResolver.rootResolve(file))
      : undefined;
  const raw = ['mission_controller', 'knowledge_steward', 'chronos_gateway'].includes(
    resolveRole() || ''
  )
    ? read()
    : withMemoryProvenanceReadCapability(scope, () =>
        withExecutionContext(MEMORY_PROVENANCE_READER_ROLE, read, undefined, scope.tenant_slug)
      );
  if (raw === undefined) return { version: 1, records: {} };
  const value = parseSafeJsonInput(raw, 'memory provenance') as MemoryProvenanceState;
  if (value?.version !== 1 || !value.records || Array.isArray(value.records))
    throw new Error('[MEMORY_PROVENANCE_INVALID] Invalid authoritative state');
  for (const [id, record] of Object.entries(value.records)) {
    if (
      !record ||
      record.source_id !== id ||
      !validOrigin(record) ||
      !Array.isArray(record.origins) ||
      !record.origins.every(validOrigin) ||
      !Array.isArray(record.source_families) ||
      record.source_families.length === 0 ||
      !record.source_families.every(isHash) ||
      new Set(record.source_families).size !== record.source_families.length ||
      (record.kind !== undefined && record.kind !== 'external') ||
      (record.unverified_refs !== undefined &&
        (!Array.isArray(record.unverified_refs) ||
          !record.unverified_refs.every((ref) => typeof ref === 'string' && !!ref.trim()))) ||
      typeof record.revoked !== 'boolean' ||
      typeof record.document_path !== 'string'
    )
      throw new Error('[MEMORY_PROVENANCE_INVALID] Malformed source record');
    const recordScope = assertMemoryScope(record.scope);
    if (
      recordScope.tier !== scope.tier ||
      recordScope.tenant_slug !== scope.tenant_slug ||
      (scope.tier === 'personal' && recordScope.owner_nhi !== scope.owner_nhi)
    )
      throw new Error('[MEMORY_PROVENANCE_INVALID] Source outside its authoritative partition');
  }
  return value;
}
function assertWriter(): void {
  if (!['mission_controller', 'knowledge_steward', 'chronos_gateway'].includes(resolveRole() || ''))
    throw new Error(
      '[MEMORY_PROVENANCE_AUTHORITY] Only governed memory producers may mutate lineage'
    );
}
function relativePath(documentPath: string): string {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(documentPath), {
    allowMissingLeaf: true,
  });
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error('[MEMORY_PROVENANCE_PATH] Source must be repository-local');
  return relative;
}
function current(
  state: MemoryProvenanceState,
  ref: MemoryOriginRef,
  scope: MemoryScopeEnvelope
): boolean {
  const record = state.records[ref.source_id];
  if (
    !record ||
    !!record.unverified_refs?.length ||
    record.revoked ||
    recordsAtPath(state, record.document_path).some(
      (alias) => alias.sha256 === record.sha256 && alias.revoked
    ) ||
    record.generation !== ref.generation ||
    record.sha256 !== ref.sha256 ||
    scopeKey(record.scope) !== scopeKey(scope)
  )
    return false;
  return record.origins.every((origin) => {
    const parent = state.records[origin.source_id];
    return (
      !!parent &&
      !parent.unverified_refs?.length &&
      !parent.revoked &&
      !recordsAtPath(state, parent.document_path).some(
        (alias) => alias.sha256 === parent.sha256 && alias.revoked
      ) &&
      parent.generation === origin.generation &&
      parent.sha256 === origin.sha256 &&
      scopeCanNarrow(parent.scope, record.scope)
    );
  });
}

function bytesCurrent(
  state: MemoryProvenanceState,
  record: MemoryProvenanceRecord,
  readHash: (file: string) => string
): boolean {
  return [record, ...record.origins.map((origin) => state.records[origin.source_id])].every(
    (source) => source.kind === 'external' || readHash(source.document_path) === source.sha256
  );
}
const fileHash = (file: string) => hash(readTextFile(pathResolver.rootResolve(file)));
function externalSourceRef(ref: string): string {
  const clean = ref.trim();
  if (/^https?:\/\//i.test(clean)) return new URL(clean).toString();
  if (!/^(?:trace|mission|task_session|artifact|event):[^\s]+$/.test(clean))
    throw new Error(
      '[MEMORY_SOURCE_REF_INVALID] Expected reviewed URL or typed evidence reference'
    );
  return clean;
}

/** Mint only after the governed producer writes the exact artifact. Caller labels confer no trust. */
export function registerMemoryProvenance(input: {
  scope: MemoryScopeEnvelope;
  documentPath: string;
  origins?: MemoryOriginRef[];
  sourceRefs?: string[];
  /** Missing local evidence is recorded for audit but excluded from decisions. */
  unverifiedRefs?: string[];
}): MemoryProvenanceRecord {
  assertWriter();
  const scope = assertMemoryScope(input.scope);
  const document_path = relativePath(input.documentPath);
  const tenant = document_path.match(
    /(?:^knowledge\/confidential\/|^active\/missions\/confidential\/)([^/]+)\//
  )?.[1];
  if (
    (tenant && tenant !== scope.tenant_slug) ||
    (scope.tier === 'public' && /(?:^|\/)(?:personal|confidential)\//.test(document_path)) ||
    KNOWLEDGE_TIER_RANK[detectTier(pathResolver.rootResolve(document_path))] >
      KNOWLEDGE_TIER_RANK[scope.tier]
  )
    throw new Error('[MEMORY_PROVENANCE_SCOPE] Source bytes cannot be relabelled to a wider scope');
  const sha256 = hash(readTextFile(pathResolver.rootResolve(document_path)));
  return withLockSync('memory-provenance:' + hash(statePath(scope)), () => {
    const state = load(scope);
    const source_id = hash(scopeKey(scope) + ':' + document_path + ':' + sha256);
    const previous = state.records[source_id];
    const versions = recordsAtPath(state, document_path);
    // Historical records are restrictive ceilings, never reusable grants.
    // An exact existing descriptor may remain idempotent; minting any new
    // descriptor/version must preserve every restriction already established.
    if (!previous && versions.some((record) => !scopeCanNarrow(record.scope, scope)))
      throw new Error('[MEMORY_PROVENANCE_SCOPE] Existing source restrictions cannot be widened');
    const aliases = versions.filter((record) => record.sha256 === sha256);
    // Tombstones belong to the whole durable partition: changing mission/task
    // context cannot resurrect revoked bytes or discard their ancestry.
    if (aliases.some((record) => !current(state, record, record.scope)))
      throw new Error('[MEMORY_SOURCE_REVOKED] Source cannot resurrect in another context');
    const inherited = aliases.find((record) => scopeCanNarrow(record.scope, scope));
    if (aliases.length && !inherited)
      throw new Error('[MEMORY_PROVENANCE_SCOPE] Existing source restrictions cannot be widened');
    const ancestors = new Map<string, MemoryOriginRef>();
    const families = new Set<string>();
    const origins = [...(input.origins || [])];
    for (const ref of input.sourceRefs || []) {
      const canonical = externalSourceRef(ref);
      const id = hash(partitionKey(scope) + ':external:' + canonical);
      state.records[id] ||= {
        kind: 'external',
        source_id: id,
        generation: 0,
        sha256: hash(canonical),
        document_path: 'external:' + id,
        scope: partitionScope(scope),
        source_families: [id],
        origins: [],
        revoked: false,
      };
      pathIndexes.delete(state);
      origins.push(state.records[id]);
    }
    for (const origin of origins) {
      if (
        !state.records[origin.source_id] ||
        !scopeCanNarrow(state.records[origin.source_id].scope, scope) ||
        !current(state, origin, state.records[origin.source_id].scope) ||
        !bytesCurrent(state, state.records[origin.source_id], fileHash)
      )
        throw new Error('[MEMORY_SOURCE_REVOKED] Invalid parent');
      const parent = state.records[origin.source_id];
      ancestors.set(parent.source_id, {
        source_id: parent.source_id,
        generation: parent.generation,
        sha256: parent.sha256,
      });
      for (const ancestor of parent.origins) ancestors.set(ancestor.source_id, ancestor);
      for (const family of parent.source_families) families.add(family);
    }
    if (inherited) {
      if (
        (input.origins !== undefined || input.sourceRefs !== undefined) &&
        JSON.stringify([...ancestors.keys()].sort()) !==
          JSON.stringify(inherited.origins.map((entry) => entry.source_id).sort())
      )
        throw new Error(
          '[MEMORY_PROVENANCE_CONFLICT] Existing bytes have different immutable lineage'
        );
      for (const origin of inherited.origins) ancestors.set(origin.source_id, origin);
      for (const family of inherited.source_families) families.add(family);
    }
    if (
      [...ancestors.values()].some(
        (origin) => state.records[origin.source_id].document_path === document_path
      )
    )
      throw new Error(
        '[MEMORY_PROVENANCE_CYCLE] A replacement cannot derive from its own old version'
      );
    if (previous) {
      if (!current(state, previous, scope))
        throw new Error('[MEMORY_SOURCE_REVOKED] Source cannot resurrect');
      if (
        (input.origins !== undefined || input.sourceRefs !== undefined) &&
        JSON.stringify([...ancestors.keys()].sort()) !==
          JSON.stringify(previous.origins.map((entry) => entry.source_id).sort())
      )
        throw new Error(
          '[MEMORY_PROVENANCE_CONFLICT] Existing bytes have different immutable lineage'
        );
      return previous;
    }
    // Replacing a source invalidates its prior version and every transitive descendant.
    for (const record of Object.values(state.records)) {
      if (record.document_path === document_path && record.sha256 !== sha256 && !record.revoked) {
        record.revoked = true;
        record.generation += 1;
        record.reason = 'superseded by new source bytes';
      }
    }
    const record: MemoryProvenanceRecord = {
      source_id,
      generation: 0,
      sha256,
      document_path,
      scope,
      source_families: families.size
        ? [...families].sort()
        : [hash(partitionKey(scope) + ':document:' + document_path)],
      origins: [...ancestors.values()].sort((a, b) => a.source_id.localeCompare(b.source_id)),
      revoked: false,
      ...(input.unverifiedRefs?.length
        ? { unverified_refs: [...input.unverifiedRefs].sort() }
        : {}),
    };
    state.records[source_id] = record;
    writeJson(statePath(scope), state);
    return record;
  });
}

export function revokeMemorySource(
  scope: MemoryScopeEnvelope,
  sourceId: string,
  reason: string
): void {
  assertWriter();
  if (!reason.trim()) throw new Error('[MEMORY_REVOCATION_REASON] A reason is required');
  withLockSync('memory-provenance:' + hash(statePath(scope)), () => {
    const state = load(scope);
    const record = state.records[sourceId];
    if (!record || scopeKey(record.scope) !== scopeKey(scope))
      throw new Error('[MEMORY_SOURCE_UNKNOWN]');
    for (const alias of recordsAtPath(state, record.document_path)) {
      if (alias.sha256 !== record.sha256) continue;
      if (!alias.revoked) alias.generation += 1;
      alias.revoked = true;
      alias.reason = reason;
    }
    writeJson(statePath(scope), state);
  });
}

/** Re-read durable current generations on every use, including after checkpoint restore. */
export function verifyMemoryOrigin(
  input: MemoryOriginRef & { scope: MemoryScopeEnvelope }
): boolean {
  try {
    const state = load(input.scope);
    if (!current(state, input, input.scope)) return false;
    const source = state.records[input.source_id];
    return source.kind !== 'external' && bytesCurrent(state, source, fileHash);
  } catch {
    return false;
  }
}

export interface MemoryEligibilityInput {
  documentPath: string;
  sha256?: string;
  scope: MemoryScopeEnvelope;
  consumerScope?: ScopeContext;
}
export interface MemoryEligibility {
  eligible: boolean;
  source_families?: string[];
  origin?: MemoryOriginRef;
}
/** Query-local snapshot only: do not retain this resolver across requests/checkpoint restores. */
export function createMemoryEligibilityResolver(): (
  input: MemoryEligibilityInput
) => MemoryEligibility {
  const states = new Map<string, MemoryProvenanceState>();
  const hashes = new Map<string, string>();
  const readHash = (file: string) => {
    if (!hashes.has(file)) hashes.set(file, fileHash(file));
    return hashes.get(file)!;
  };
  return (input) =>
    resolveEligibility(
      input,
      (scope) => {
        const key = statePath(scope);
        if (!states.has(key)) states.set(key, load(scope));
        return states.get(key)!;
      },
      readHash
    );
}
export function resolveMemoryEligibility(input: MemoryEligibilityInput): MemoryEligibility {
  return resolveEligibility(input, load, fileHash);
}
function resolveEligibility(
  input: MemoryEligibilityInput,
  readState: typeof load,
  readHash: typeof fileHash
): MemoryEligibility {
  try {
    const scope = assertMemoryScope(input.scope);
    if (input.consumerScope && !memoryScopeAllowsRead(scope, input.consumerScope))
      return { eligible: false };
    const documentPath = relativePath(input.documentPath);
    const state = readState(scope);
    const records = recordsAtPath(state, documentPath);
    if (!records.length) return { eligible: true };
    const record = records.find(
      (entry) =>
        entry.sha256 === input.sha256 &&
        memoryScopeAllowsRead(entry.scope, input.consumerScope || scope) &&
        current(state, entry, entry.scope)
    );
    if (
      !record ||
      !memoryScopeAllowsRead(record.scope, input.consumerScope || scope) ||
      !current(state, record, record.scope) ||
      !bytesCurrent(state, record, readHash)
    )
      return { eligible: false };
    return {
      eligible: true,
      source_families: record.source_families,
      origin: { source_id: record.source_id, generation: record.generation, sha256: record.sha256 },
    };
  } catch {
    return { eligible: false };
  }
}

/** One ranked representative per independently registered family, before top-k truncation. */
export function selectIndependentMemory<T>(
  ranked: readonly T[],
  families: (entry: T) => readonly string[]
): T[] {
  const seen = new Set<string>();
  return ranked.filter((entry) => {
    const keys = families(entry);
    if (keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
}
