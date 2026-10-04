import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';

export interface VisemeProviderMappings {
  version: string;
  providers: Array<{ provider_id: string; visemes: Record<string, string> }>;
}

const catalog = defineCatalog<VisemeProviderMappings>({
  id: 'viseme-provider-mappings',
  path: pathResolver.knowledge('product/governance/viseme-provider-mappings.json'),
  schema: pathResolver.knowledge('product/schemas/viseme-provider-mappings.schema.json'),
});
let cachedMappings: VisemeProviderMappings | null = null;

export function resolveCanonicalViseme(providerId: string, visemeId: number): string | undefined {
  const provider = providerId.trim().toLowerCase();
  if (!provider || !Number.isInteger(visemeId) || visemeId < 0) return undefined;
  cachedMappings ??= catalog.load();
  const mapping = cachedMappings.providers.find(
    (entry) => entry.provider_id.toLowerCase() === provider
  );
  return mapping?.visemes[String(visemeId)];
}
