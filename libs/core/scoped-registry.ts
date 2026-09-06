/**
 * DH-09: deterministic scope-chain registry.
 *
 * Values registered at an ancestor scope are visible to descendants. A value
 * with the same id at a more specific scope shadows its ancestor. Scope
 * depth, never registration/load order, decides the winner; two equally
 * specific matches are rejected as ambiguous.
 */

import { ENTITY_SCOPE_HIERARCHY, type EntityScopeKey } from './entity-scope.js';

/**
 * Registry scope ordering is the entity containment ordering. Keep this as a
 * reference to the canonical declaration so a new entity level cannot be
 * added to one model and silently omitted from the other.
 */
export const SCOPED_REGISTRY_LEVELS = ENTITY_SCOPE_HIERARCHY;

export type ScopedRegistryLevel = EntityScopeKey;

type LegacyScopedRegistryLevel =
  'tenant' | 'organization' | 'project' | 'mission' | 'task' | 'session';

const LEGACY_SCOPE_LEVELS: Readonly<Record<LegacyScopedRegistryLevel, ScopedRegistryLevel>> = {
  tenant: 'tenant_slug',
  organization: 'organization_id',
  project: 'project_id',
  mission: 'mission_id',
  task: 'task_id',
  session: 'session',
};

/**
 * Legacy short keys remain accepted at the boundary for persisted callers and
 * existing integrations. They are normalized immediately to entity-scope
 * keys; entries and canonical keys never expose the legacy vocabulary.
 */
export type ScopedRegistryScope = Partial<Record<ScopedRegistryLevel, string>> &
  Partial<Record<LegacyScopedRegistryLevel, string>>;

export type ScopedRegistryEvent = 'added' | 'removed';

export interface ScopedRegistryEntry<T> {
  id: string;
  value: T;
  scope: Readonly<ScopedRegistryScope>;
  scope_key: string;
  depth: number;
}

export interface ScopedRegistryEventPayload<T> {
  event: ScopedRegistryEvent;
  entry: ScopedRegistryEntry<T>;
}

type Listener<T> = (payload: ScopedRegistryEventPayload<T>) => void;

function normalizeScope(scope: ScopedRegistryScope): Readonly<ScopedRegistryScope> {
  const normalized: Partial<Record<ScopedRegistryLevel, string>> = {};
  for (const [rawLevel, value] of Object.entries(scope)) {
    if (value === undefined) continue;
    const level = (SCOPED_REGISTRY_LEVELS as readonly string[]).includes(rawLevel)
      ? (rawLevel as ScopedRegistryLevel)
      : LEGACY_SCOPE_LEVELS[rawLevel as LegacyScopedRegistryLevel];
    // Preserve the previous permissive boundary for unrelated metadata while
    // canonicalizing all known scope vocabulary.
    if (!level) continue;
    const trimmed = String(value).trim();
    if (!trimmed) throw new Error(`[SCOPED_REGISTRY_SCOPE] ${rawLevel} cannot be empty`);
    if (normalized[level] !== undefined && normalized[level] !== trimmed) {
      throw new Error(
        `[SCOPED_REGISTRY_SCOPE] conflicting values for ${level}: ${normalized[level]} and ${trimmed}`
      );
    }
    normalized[level] = trimmed;
  }
  return normalized;
}

function scopeKey(scope: Readonly<ScopedRegistryScope>): string {
  return SCOPED_REGISTRY_LEVELS.map((level) => `${level}=${scope[level] || ''}`).join('|');
}

function scopeDepth(scope: Readonly<ScopedRegistryScope>): number {
  return SCOPED_REGISTRY_LEVELS.reduce((depth, level) => depth + (scope[level] ? 1 : 0), 0);
}

function isAncestorOrSelf(
  candidate: Readonly<ScopedRegistryScope>,
  target: Readonly<ScopedRegistryScope>
): boolean {
  return SCOPED_REGISTRY_LEVELS.every(
    (level) => candidate[level] === undefined || candidate[level] === target[level]
  );
}

function normalizeId(id: string): string {
  const normalized = String(id).trim();
  if (!normalized) throw new Error('[SCOPED_REGISTRY_CONFIG] id is required');
  return normalized;
}

export function canonicalizeScopedRegistryScope(scope: ScopedRegistryScope): string {
  return scopeKey(normalizeScope(scope));
}

export class ScopedRegistry<T> {
  private readonly entries = new Map<string, ScopedRegistryEntry<T>>();
  private readonly listeners = new Map<ScopedRegistryEvent, Set<Listener<T>>>([
    ['added', new Set()],
    ['removed', new Set()],
  ]);

  register(scope: ScopedRegistryScope, id: string, value: T): () => void {
    const normalizedScope = normalizeScope(scope);
    const normalizedId = normalizeId(id);
    const key = `${scopeKey(normalizedScope)}::${normalizedId}`;
    if (this.entries.has(key)) {
      throw new Error(
        `[SCOPED_REGISTRY_CONFIG] duplicate registration: ${normalizedId} at ${scopeKey(normalizedScope)}`
      );
    }
    const entry: ScopedRegistryEntry<T> = {
      id: normalizedId,
      value,
      scope: normalizedScope,
      scope_key: scopeKey(normalizedScope),
      depth: scopeDepth(normalizedScope),
    };
    this.entries.set(key, entry);
    this.emit('added', entry);
    return () => {
      if (this.entries.get(key) !== entry) return;
      this.entries.delete(key);
      this.emit('removed', entry);
    };
  }

  on(event: ScopedRegistryEvent, listener: Listener<T>): () => void {
    const listeners = this.listeners.get(event);
    if (!listeners) throw new Error(`[SCOPED_REGISTRY_CONFIG] unknown event: ${event}`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Return one visible value, or undefined when no scope contains the id. */
  get(scope: ScopedRegistryScope, id: string): T | undefined {
    return this.getEntry(scope, id)?.value;
  }

  getEntry(scope: ScopedRegistryScope, id: string): ScopedRegistryEntry<T> | undefined {
    const normalizedScope = normalizeScope(scope);
    const normalizedId = normalizeId(id);
    const matches = [...this.entries.values()].filter(
      (entry) => entry.id === normalizedId && isAncestorOrSelf(entry.scope, normalizedScope)
    );
    if (matches.length === 0) return undefined;
    const maxDepth = Math.max(...matches.map((entry) => entry.depth));
    const winners = matches.filter((entry) => entry.depth === maxDepth);
    if (winners.length > 1) {
      throw new Error(
        `[SCOPED_REGISTRY_AMBIGUOUS] ${normalizedId} at ${scopeKey(normalizedScope)}: ${winners
          .map((entry) => entry.scope_key)
          .sort()
          .join(', ')}`
      );
    }
    return winners[0];
  }

  /** Return the complete visible view, shadowed and sorted deterministically. */
  list(scope: ScopedRegistryScope): ScopedRegistryEntry<T>[] {
    const normalizedScope = normalizeScope(scope);
    const ids = new Set(
      [...this.entries.values()]
        .filter((entry) => isAncestorOrSelf(entry.scope, normalizedScope))
        .map((entry) => entry.id)
    );
    return [...ids]
      .map((id) => this.getEntry(normalizedScope, id))
      .filter((entry): entry is ScopedRegistryEntry<T> => entry !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Return every registered entry, including shadowed values. */
  listAll(): ScopedRegistryEntry<T>[] {
    return [...this.entries.values()].sort((left, right) =>
      `${left.scope_key}::${left.id}`.localeCompare(`${right.scope_key}::${right.id}`)
    );
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) {
      const key = `${entry.scope_key}::${entry.id}`;
      this.entries.delete(key);
      this.emit('removed', entry);
    }
  }

  private emit(event: ScopedRegistryEvent, entry: ScopedRegistryEntry<T>): void {
    for (const listener of this.listeners.get(event) || []) {
      try {
        listener({ event, entry });
      } catch {
        // Registry observers are telemetry/projection consumers; a broken
        // observer must not change registration semantics.
      }
    }
  }
}
