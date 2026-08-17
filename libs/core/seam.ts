/**
 * Explicit provider seams.
 *
 * A seam is a small, runtime-owned registry for an extension point.  It is
 * deliberately strict: duplicate providers and ambiguous lookups fail
 * instead of silently selecting the last registration.
 */

import { assertModuleInvariant } from './invariants.js';

export type SeamMultiplicity = 'sole' | 'named';
export type SeamProviderProvenance = 'builtin' | 'plugin' | 'tenant-overlay' | 'generated';

export interface SeamProviderMetadata {
  provenance: SeamProviderProvenance;
  source?: string;
  /** DH-03: deterministic explanation for why this provider is bound. */
  reason?: string;
}

export interface SeamProviderRecord<T> {
  id: string;
  implementation: T;
  metadata: SeamProviderMetadata;
}

export interface SeamDefinition<T> {
  key: string;
  multiplicity: SeamMultiplicity;
  select?: (providers: readonly SeamProviderRecord<T>[], selector?: string) => T | undefined;
  catalog?: SeamCatalog;
}

export interface SeamBindingSnapshot {
  key: string;
  multiplicity: SeamMultiplicity;
  providers: Array<{ id: string; metadata: SeamProviderMetadata }>;
}

export interface SeamCatalog {
  register<T>(seam: Seam<T>): () => void;
  get<T>(key: string): Seam<T> | undefined;
  list(): SeamBindingSnapshot[];
}

export interface Seam<T> {
  readonly key: string;
  readonly multiplicity: SeamMultiplicity;
  register(id: string, implementation: T, metadata: SeamProviderMetadata): () => void;
  get(selector?: string): T;
  getOptional(selector?: string): T | undefined;
  list(): readonly SeamProviderRecord<T>[];
  on(event: 'added' | 'removed', listener: (provider: SeamProviderRecord<T>) => void): () => void;
}

export class SeamError extends Error {
  readonly code:
    | 'SEAM_INVALID_DEFINITION'
    | 'SEAM_DUPLICATE_PROVIDER'
    | 'SEAM_PROVIDER_MISSING'
    | 'SEAM_PROVIDER_AMBIGUOUS';
  readonly seamKey: string;
  readonly providerIds: readonly string[];

  constructor(
    code: SeamError['code'],
    seamKey: string,
    message: string,
    providerIds: readonly string[] = []
  ) {
    super(message);
    this.name = 'SeamError';
    this.code = code;
    this.seamKey = seamKey;
    this.providerIds = providerIds;
  }
}

export function createSeamCatalog(): SeamCatalog {
  const seams = new Map<string, Seam<unknown>>();
  return {
    register<T>(seam: Seam<T>) {
      if (seams.has(seam.key)) {
        throw new SeamError(
          'SEAM_DUPLICATE_PROVIDER',
          seam.key,
          `Seam ${seam.key} is already registered in the catalog`
        );
      }
      seams.set(seam.key, seam as Seam<unknown>);
      return () => {
        if (seams.get(seam.key) === seam) seams.delete(seam.key);
      };
    },
    get<T>(key: string) {
      return seams.get(key) as Seam<T> | undefined;
    },
    list() {
      return [...seams.values()]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((seam) => ({
          key: seam.key,
          multiplicity: seam.multiplicity,
          providers: seam
            .list()
            .map(({ id, metadata }) => ({ id, metadata: withBindingReason(metadata) })),
        }));
    },
  };
}

/** Catalog for the production core seams; tests can create isolated catalogs. */
export const coreSeamCatalog = createSeamCatalog();

function assertNonEmpty(value: string, field: string, seamKey: string): void {
  if (!value.trim()) {
    throw new SeamError(
      'SEAM_INVALID_DEFINITION',
      seamKey,
      `${field} must be a non-empty string for seam ${seamKey}`
    );
  }
}

function canonicalProviders<T>(
  providers: Map<string, SeamProviderRecord<T>>
): SeamProviderRecord<T>[] {
  return [...providers.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function withBindingReason(metadata: SeamProviderMetadata): SeamProviderMetadata {
  const reason = metadata.reason?.trim();
  return {
    ...metadata,
    reason:
      reason ||
      (metadata.source ? `source:${metadata.source}` : `provenance:${metadata.provenance}`),
  };
}

export function defineSeam<T>(definition: SeamDefinition<T>): Seam<T> {
  assertNonEmpty(definition.key, 'key', definition.key || '<unknown>');
  const providers = new Map<string, SeamProviderRecord<T>>();
  const listeners = {
    added: new Set<(provider: SeamProviderRecord<T>) => void>(),
    removed: new Set<(provider: SeamProviderRecord<T>) => void>(),
  };

  const resolve = (selector?: string): T | undefined => {
    const available = canonicalProviders(providers);
    if (definition.select) return definition.select(available, selector);
    if (definition.multiplicity === 'sole') return available[0]?.implementation;
    if (selector) return providers.get(selector)?.implementation;
    return available.length === 1 ? available[0].implementation : undefined;
  };

  const get = (selector?: string): T => {
    const available = canonicalProviders(providers);
    const selected = resolve(selector);
    if (selected !== undefined) return selected;

    if (available.length === 0 || selector) {
      throw new SeamError(
        'SEAM_PROVIDER_MISSING',
        definition.key,
        selector
          ? `No provider '${selector}' is registered for seam ${definition.key}`
          : `No provider is registered for seam ${definition.key}`,
        selector ? [selector] : []
      );
    }

    throw new SeamError(
      'SEAM_PROVIDER_AMBIGUOUS',
      definition.key,
      `Provider selection is ambiguous for seam ${definition.key}; choose one of: ${available
        .map((provider) => provider.id)
        .join(', ')}`,
      available.map((provider) => provider.id)
    );
  };

  const seam: Seam<T> = {
    key: definition.key,
    multiplicity: definition.multiplicity,
    register(id, implementation, metadata) {
      assertNonEmpty(id, 'provider id', definition.key);
      assertModuleInvariant('seam', 'provider-metadata', { metadata });
      if (providers.has(id)) {
        throw new SeamError(
          'SEAM_DUPLICATE_PROVIDER',
          definition.key,
          `Provider ${id} is already registered for seam ${definition.key}`,
          [id]
        );
      }
      if (definition.multiplicity === 'sole' && providers.size > 0) {
        const existing = canonicalProviders(providers);
        throw new SeamError(
          'SEAM_DUPLICATE_PROVIDER',
          definition.key,
          `Sole seam ${definition.key} already has provider ${existing[0].id}`,
          existing.map((provider) => provider.id)
        );
      }

      const provider = { id, implementation, metadata };
      providers.set(id, provider);
      for (const listener of listeners.added) listener(provider);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (providers.get(id) !== provider) return;
        providers.delete(id);
        for (const listener of listeners.removed) listener(provider);
      };
    },
    get,
    getOptional(selector) {
      try {
        return get(selector);
      } catch (error) {
        if (error instanceof SeamError && error.code === 'SEAM_PROVIDER_MISSING') return undefined;
        throw error;
      }
    },
    list() {
      return canonicalProviders(providers);
    },
    on(event, listener) {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  };
  definition.catalog?.register(seam);
  return seam;
}
