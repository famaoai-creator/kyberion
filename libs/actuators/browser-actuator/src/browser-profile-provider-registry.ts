import { pathToFileURL } from 'node:url';
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeStat } from '@agent/core/secure-io';
import type { BrowserProfile } from './browser-profile-manager.js';

export interface BrowserProfileProviderModule {
  listProfiles(options?: {
    customChromeDir?: string;
    customPlaywrightDir?: string;
  }): BrowserProfile[] | Promise<BrowserProfile[]>;
  openProfile(
    profile: BrowserProfile,
    url: string,
    print: (message: string) => void
  ): Promise<void>;
}
interface Descriptor {
  provider_id: string;
  module: string;
  fallback_path?: string;
}
interface Registry {
  version: string;
  providers: Descriptor[];
}
const catalog = defineCatalog<Registry>({
  id: 'browser-profile-providers',
  path: () => pathResolver.knowledge('product/governance/browser-profile-providers.json'),
  schema: pathResolver.knowledge('product/schemas/browser-profile-providers.schema.json'),
});
const loaded = new Map<string, Promise<BrowserProfileProviderModule>>();

async function loadProvider(providerId: string): Promise<BrowserProfileProviderModule | undefined> {
  const descriptor = catalog.load().providers.find((item) => item.provider_id === providerId);
  if (!descriptor) return undefined;
  let pending = loaded.get(providerId);
  if (!pending) {
    pending = (async () => {
      let module: { browserProfileProvider?: BrowserProfileProviderModule };
      try {
        module = (await import(descriptor.module)) as typeof module;
      } catch (error) {
        const fallback = descriptor.fallback_path;
        if (!fallback || fallback.startsWith('/') || fallback.split(/[\\/]/u).includes('..'))
          throw error;
        const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(fallback));
        if (!safeStat(safePath).isFile())
          throw new Error('Browser profile provider fallback must be a regular file');
        module = (await import(pathToFileURL(safePath).href)) as typeof module;
      }
      const provider = module.browserProfileProvider;
      if (
        !provider ||
        typeof provider.listProfiles !== 'function' ||
        typeof provider.openProfile !== 'function'
      )
        throw new Error('Browser profile provider must export listProfiles and openProfile');
      return provider;
    })();
    loaded.set(providerId, pending);
  }
  return pending;
}

export async function discoverBrowserProfiles(
  options: {
    provider?: string | 'all';
    customChromeDir?: string;
    customPlaywrightDir?: string;
  } = {}
): Promise<BrowserProfile[]> {
  const registry = catalog.load();
  if (
    options.provider &&
    options.provider !== 'all' &&
    !registry.providers.some((item) => item.provider_id === options.provider)
  ) {
    throw new Error('Unknown browser profile provider: ' + options.provider);
  }
  const descriptors = registry.providers.filter(
    (item) =>
      !options.provider || options.provider === 'all' || item.provider_id === options.provider
  );
  const groups = await Promise.all(
    descriptors.map(async (item) => {
      const provider = await loadProvider(item.provider_id);
      if (!provider) return [];
      const profiles = await provider.listProfiles(options);
      for (const profile of profiles) {
        if (profile.provider !== item.provider_id)
          throw new Error(
            'Browser profile provider returned a profile under the wrong provider ID: ' +
              item.provider_id
          );
      }
      return profiles;
    })
  );
  return groups.flat();
}
export async function resolveRegisteredBrowserProfile(query: {
  provider?: string;
  profile: string;
}): Promise<BrowserProfile | undefined> {
  const term = query.profile.trim().toLowerCase();
  if (!term) return undefined;
  return (await discoverBrowserProfiles({ provider: query.provider })).find(
    (profile) =>
      profile.id.toLowerCase() === term ||
      profile.name.toLowerCase() === term ||
      profile.email?.toLowerCase() === term ||
      profile.name.toLowerCase().includes(term) ||
      profile.id.toLowerCase().includes(term)
  );
}

export async function openRegisteredBrowserProfile(
  profile: BrowserProfile,
  url: string,
  print: (message: string) => void
): Promise<void> {
  const provider = await loadProvider(profile.provider);
  if (!provider) throw new Error('Unknown browser profile provider: ' + profile.provider);
  await provider.openProfile(profile, url, print);
}
