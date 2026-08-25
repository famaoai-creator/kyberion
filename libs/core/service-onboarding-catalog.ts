import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface ServiceOnboardingCatalogEntry {
  service_id: string;
  prompt_kind: 'comfyui' | 'whisper' | 'generic';
  label?: string;
  notes?: string;
}

interface ServiceOnboardingCatalog {
  version: string;
  services: ServiceOnboardingCatalogEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/service-onboarding-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-onboarding-catalog.schema.json'
);

const catalog = defineCatalog<ServiceOnboardingCatalog>({
  id: 'service-onboarding-catalog',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: { version: '1.0.0', services: [] },
});

export function loadServiceOnboardingCatalog(): ServiceOnboardingCatalog {
  return catalog.load();
}

export function listServiceOnboardingCatalogEntries(): ServiceOnboardingCatalogEntry[] {
  return loadServiceOnboardingCatalog().services;
}

export function getServiceOnboardingCatalogEntry(
  serviceId: string
): ServiceOnboardingCatalogEntry | null {
  const normalized = serviceId.trim();
  if (!normalized) return null;
  return (
    listServiceOnboardingCatalogEntries().find((entry) => entry.service_id === normalized) || null
  );
}
