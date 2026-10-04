/**
 * Public ingress registry + resolver (adapter-first layers 3 and 4).
 *
 * Descriptors come from knowledge/product/governance/public-ingress-providers.json.
 * A `live` descriptor names a provider module that exports
 * `createPublicIngressProvider()`; the module is imported on demand and
 * registered into the `public-ingress-provider` seam. `planned` / `disabled`
 * descriptors stay visible with readiness `unsupported` and a reason — they
 * are never hidden and never silently replaced.
 *
 * Selection: an explicit provider (`--provider`, else KYBERION_INGRESS_PROVIDER)
 * is used as-is and fails with its readiness reason when not ready; without
 * one, the first live provider in catalog order whose readiness is `ready`
 * wins. The chosen route and the reason are part of the result.
 */
import { pathToFileURL } from 'node:url';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeStat } from '../secure-io.js';
import {
  IngressError,
  type IngressNetworkClass,
  type IngressReadiness,
  type PublicIngressProvider,
} from './public-ingress-contract.js';
import {
  getRegisteredPublicIngressProvider,
  registerPublicIngressProvider,
} from './public-ingress-seam.js';

export type PublicIngressProviderStatus = 'live' | 'planned' | 'disabled';

export interface PublicIngressProviderDescriptor {
  provider_id: string;
  display_name: string;
  status: PublicIngressProviderStatus;
  adapter: 'cli';
  module?: string;
  fallback_path?: string;
  tool_id: string;
  stable_url: boolean;
  network_class: IngressNetworkClass;
  secret_refs: string[];
  config_requirements?: string[];
  platforms: string[];
  notes?: string;
}

export interface PublicIngressProviderRegistry {
  version: string;
  description?: string;
  providers: PublicIngressProviderDescriptor[];
}

export interface PublicIngressProviderModule {
  createPublicIngressProvider?: () => PublicIngressProvider;
}

const publicIngressProviderCatalog = defineCatalog<PublicIngressProviderRegistry>({
  id: 'public-ingress-providers',
  path: () => pathResolver.knowledge('product/governance/public-ingress-providers.json'),
  schema: pathResolver.knowledge('product/schemas/public-ingress-providers.schema.json'),
});

export function listPublicIngressProviderDescriptors(): PublicIngressProviderDescriptor[] {
  return publicIngressProviderCatalog.load().providers;
}

export function getPublicIngressProviderDescriptor(
  providerId: string
): PublicIngressProviderDescriptor | undefined {
  return listPublicIngressProviderDescriptors().find((entry) => entry.provider_id === providerId);
}

function resolveFallbackModulePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.split(/[\\/]/u).includes('..')
  ) {
    throw new Error('fallback_path must remain repository-relative');
  }
  const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath));
  if (!safeStat(safePath).isFile()) throw new Error('fallback_path must be a regular file');
  return safePath;
}

async function importProviderModule(
  descriptor: PublicIngressProviderDescriptor
): Promise<PublicIngressProviderModule> {
  if (!descriptor.module) throw new Error('descriptor declares no provider module');
  try {
    return (await import(descriptor.module)) as PublicIngressProviderModule;
  } catch (packageError) {
    if (!descriptor.fallback_path) throw packageError;
    const fallback = resolveFallbackModulePath(descriptor.fallback_path);
    return (await import(pathToFileURL(fallback).href)) as PublicIngressProviderModule;
  }
}

const pendingLoads = new Map<string, Promise<PublicIngressProvider>>();

/**
 * Load (and register) the adapter for a live descriptor. A provider already
 * registered in the seam (a plugin or a test double) is reused as-is.
 */
export async function loadPublicIngressProvider(
  descriptor: PublicIngressProviderDescriptor
): Promise<PublicIngressProvider> {
  const registered = getRegisteredPublicIngressProvider(descriptor.provider_id);
  if (registered) return registered;
  let pending = pendingLoads.get(descriptor.provider_id);
  if (!pending) {
    pending = (async () => {
      const providerModule = await importProviderModule(descriptor);
      if (typeof providerModule.createPublicIngressProvider !== 'function') {
        throw new Error('provider module must export createPublicIngressProvider()');
      }
      const provider = providerModule.createPublicIngressProvider();
      if (!provider || provider.id !== descriptor.provider_id) {
        throw new Error(
          `provider module returned id '${String(provider?.id)}' for descriptor '${descriptor.provider_id}'`
        );
      }
      const existing = getRegisteredPublicIngressProvider(descriptor.provider_id);
      if (existing) return existing;
      registerPublicIngressProvider(provider, {
        provenance: 'builtin',
        source: 'public-ingress-providers.json',
        reason: `catalog descriptor ${descriptor.provider_id} (${descriptor.status})`,
      });
      return provider;
    })();
    pendingLoads.set(descriptor.provider_id, pending);
    pending.catch(() => pendingLoads.delete(descriptor.provider_id));
  }
  return pending;
}

/** Test helper: forget in-flight / memoized module loads. */
export function resetPublicIngressProviderLoads(): void {
  pendingLoads.clear();
}

export interface PublicIngressCandidate {
  provider_id: string;
  display_name: string;
  status: PublicIngressProviderStatus;
  stable_url: boolean;
  network_class: IngressNetworkClass;
  secret_refs: string[];
  readiness: IngressReadiness;
}

function unsupported(
  descriptor: PublicIngressProviderDescriptor,
  reason: string
): IngressReadiness {
  return { status: 'unsupported', reason, network_class: descriptor.network_class };
}

/** Readiness of one descriptor; never throws (failures are `unsupported` with a reason). */
export async function probePublicIngressDescriptor(
  descriptor: PublicIngressProviderDescriptor,
  platform: string = process.platform
): Promise<IngressReadiness> {
  if (descriptor.status === 'planned') {
    return unsupported(descriptor, 'provider module not implemented yet (catalog status planned)');
  }
  if (descriptor.status === 'disabled') {
    return unsupported(descriptor, 'provider is disabled in public-ingress-providers.json');
  }
  if (!descriptor.platforms.includes(platform)) {
    return unsupported(descriptor, `provider does not support platform ${platform}`);
  }
  let provider: PublicIngressProvider;
  try {
    provider = await loadPublicIngressProvider(descriptor);
  } catch (error) {
    return unsupported(
      descriptor,
      `provider module failed to load: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    return await provider.probe();
  } catch (error) {
    return unsupported(
      descriptor,
      `readiness probe failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function toCandidate(
  descriptor: PublicIngressProviderDescriptor,
  readiness: IngressReadiness
): PublicIngressCandidate {
  return {
    provider_id: descriptor.provider_id,
    display_name: descriptor.display_name,
    status: descriptor.status,
    stable_url: descriptor.stable_url,
    network_class: descriptor.network_class,
    secret_refs: [...descriptor.secret_refs],
    readiness,
  };
}

/** Readiness for every declared provider, in catalog (= fallback) order. */
export async function listPublicIngressCandidates(
  options: { platform?: string } = {}
): Promise<PublicIngressCandidate[]> {
  const descriptors = listPublicIngressProviderDescriptors();
  const readiness = await Promise.all(
    descriptors.map((descriptor) => probePublicIngressDescriptor(descriptor, options.platform))
  );
  return descriptors.map((descriptor, index) => toCandidate(descriptor, readiness[index]!));
}

export type PublicIngressSelectionRoute = 'explicit' | 'env' | 'default';

export interface PublicIngressSelection {
  provider: PublicIngressProvider;
  candidate: PublicIngressCandidate;
  route: PublicIngressSelectionRoute;
  /** Operator-facing explanation of why this provider was chosen. */
  reason: string;
  /** Every candidate considered, in order (for visible fallback reporting). */
  candidates: PublicIngressCandidate[];
}

function describeCandidates(candidates: PublicIngressCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.provider_id}=${candidate.readiness.status} (${candidate.readiness.reason})`
    )
    .join('; ');
}

/** Pick the provider for an exposure; throws IngressError with every reason when none fits. */
export async function selectPublicIngressProvider(
  options: { providerId?: string; platform?: string } = {}
): Promise<PublicIngressSelection> {
  const explicit = options.providerId?.trim();
  const fromEnv = explicit ? undefined : getRegisteredEnvText('KYBERION_INGRESS_PROVIDER')?.trim();
  const requested = explicit || fromEnv;
  const route: PublicIngressSelectionRoute = explicit ? 'explicit' : fromEnv ? 'env' : 'default';

  if (requested) {
    const descriptor = getPublicIngressProviderDescriptor(requested);
    if (!descriptor) {
      const known = listPublicIngressProviderDescriptors()
        .map((entry) => entry.provider_id)
        .join(', ');
      throw new IngressError(
        'INGRESS_PROVIDER_UNKNOWN',
        `unknown ingress provider '${requested}' (${route === 'env' ? 'KYBERION_INGRESS_PROVIDER' : '--provider'}); declared: ${known}`,
        requested
      );
    }
    const readiness = await probePublicIngressDescriptor(descriptor, options.platform);
    const candidate = toCandidate(descriptor, readiness);
    if (readiness.status !== 'ready') {
      throw new IngressError(
        'INGRESS_PROVIDER_NOT_READY',
        `${requested} is ${readiness.status}: ${readiness.reason}`,
        requested
      );
    }
    return {
      provider: await loadPublicIngressProvider(descriptor),
      candidate,
      route,
      reason:
        route === 'explicit'
          ? `requested with --provider ${requested}`
          : `requested by KYBERION_INGRESS_PROVIDER=${requested}`,
      candidates: [candidate],
    };
  }

  const candidates = await listPublicIngressCandidates({ platform: options.platform });
  const index = candidates.findIndex(
    (candidate) => candidate.status === 'live' && candidate.readiness.status === 'ready'
  );
  if (index < 0) {
    throw new IngressError(
      'INGRESS_NO_READY_PROVIDER',
      `no public ingress provider is ready: ${describeCandidates(candidates)}`
    );
  }
  const candidate = candidates[index]!;
  const skipped = candidates.slice(0, index);
  const descriptor = getPublicIngressProviderDescriptor(candidate.provider_id)!;
  return {
    provider: await loadPublicIngressProvider(descriptor),
    candidate,
    route: 'default',
    reason:
      skipped.length === 0
        ? `first ready provider in catalog order`
        : `first ready provider in catalog order; skipped ${describeCandidates(skipped)}`,
    candidates,
  };
}
