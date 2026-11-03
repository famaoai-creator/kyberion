/**
 * Provider registry factory — one seam + one lifecycle per extension point.
 *
 * Domains that used to hand-write register/list/reset wrappers around a
 * named seam (ocr-provider, image-generation-provider, music-generation-provider,
 * …) declare a registry once here and re-export thin domain functions. New
 * extension points get registration, listing, lookup, revision tracking and
 * reset without copying the boilerplate again.
 */

import {
  coreSeamCatalog,
  createSeam,
  createSeamLifecycle,
  type Seam,
  type SeamCatalog,
  type SeamProviderMetadata,
} from './seam.js';

export interface ProviderRegistryOptions<T> {
  /** Named seam key, e.g. 'ocr-provider'. */
  seam: string;
  /** Repo-relative owner path recorded on the seam (reevaluation identity). */
  owner: string;
  /**
   * `source` used on the default registration metadata, e.g.
   * 'ocr-provider-extension'. Builtin composition passes its own metadata.
   */
  source: string;
  catalog?: SeamCatalog;
  /** Wrap each provider at registration time (admission governance, proxies). */
  govern?: (provider: T) => T;
  /** Error thrown when a provider's id is blank. */
  missingIdError: string;
}

export interface ProviderRegistry<T> {
  readonly seam: Seam<T>;
  /** Bumped on every registration/removal; bridges cache routers against it. */
  revision(): number;
  register(provider: T, metadata?: SeamProviderMetadata): () => void;
  list(): T[];
  get(id: string): T | undefined;
  reset(): void;
}

export function createProviderRegistry<T extends { id?: string }>(
  options: ProviderRegistryOptions<T>
): ProviderRegistry<T> {
  const seam = createSeam<T>({
    key: options.seam,
    multiplicity: 'named',
    catalog: options.catalog ?? coreSeamCatalog,
    owner: options.owner,
  });
  let revision = 0;
  const lifecycle = createSeamLifecycle(seam, {
    onChange: () => {
      revision++;
    },
  });
  return {
    seam,
    revision: () => revision,
    register(provider, metadata = { provenance: 'plugin', source: options.source }) {
      const id = String(provider.id || '').trim();
      if (!id) throw new Error(options.missingIdError);
      return lifecycle.register(id, options.govern ? options.govern(provider) : provider, metadata);
    },
    list() {
      return seam.list().map((record) => record.implementation);
    },
    get(id) {
      return seam.getOptional(id);
    },
    reset() {
      lifecycle.reset();
    },
  };
}
