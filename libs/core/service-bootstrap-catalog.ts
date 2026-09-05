import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

export interface ServiceBootstrapCatalogEntry {
  id: string;
  service_id: string;
  service_type: string;
  binding_id: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  utterance_patterns?: Array<TextMatchRule | string>;
  default_for_surfaces?: string[];
  summary?: string;
}

interface ServiceBootstrapCatalog {
  version: string;
  entries: ServiceBootstrapCatalogEntry[];
}

const PUBLIC_CATALOG_PATH = pathResolver.knowledge(
  'product/governance/service-bootstrap-catalog.json'
);
const PERSONAL_CATALOG_PATH = pathResolver.knowledge(
  'personal/governance/service-bootstrap-catalog.json'
);
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/service-bootstrap-catalog.schema.json');

const publicCatalog = defineCatalog<ServiceBootstrapCatalog>({
  id: 'service-bootstrap-catalog.public',
  path: PUBLIC_CATALOG_PATH,
  schema: SCHEMA_PATH,
});

const personalCatalog = defineCatalog<ServiceBootstrapCatalog>({
  id: 'service-bootstrap-catalog.personal',
  path: PERSONAL_CATALOG_PATH,
  schema: SCHEMA_PATH,
});

function mergeCatalogs(
  base: ServiceBootstrapCatalog,
  overlay: ServiceBootstrapCatalog
): ServiceBootstrapCatalog {
  const byId = new Map<string, ServiceBootstrapCatalogEntry>();
  for (const entry of base.entries) byId.set(entry.id, entry);
  for (const entry of overlay.entries) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    entries: Array.from(byId.values()),
  };
}

export function loadServiceBootstrapCatalog(): ServiceBootstrapCatalog {
  const base = publicCatalog.load();
  const personal = safeExistsSync(PERSONAL_CATALOG_PATH)
    ? personalCatalog.load()
    : { version: base.version, entries: [] };
  return mergeCatalogs(base, {
    ...personal,
    version: personal.version || base.version,
  });
}

export function listServiceBootstrapCatalogEntries(): ServiceBootstrapCatalogEntry[] {
  return loadServiceBootstrapCatalog().entries;
}

export function findServiceBootstrapEntriesByUtterance(
  utterance: string
): ServiceBootstrapCatalogEntry[] {
  const normalized = utterance.trim();
  if (!normalized) return [];
  return listServiceBootstrapCatalogEntries().filter((entry) =>
    matchesAnyTextRule(normalized, entry.utterance_patterns)
  );
}

export function getServiceBootstrapCatalogEntryByServiceId(
  serviceId: string
): ServiceBootstrapCatalogEntry | null {
  const normalized = serviceId.trim();
  if (!normalized) return null;
  return (
    listServiceBootstrapCatalogEntries().find((entry) => entry.service_id === normalized) || null
  );
}

export function getDefaultServiceIdForSurface(surface: string): string | null {
  const normalized = surface.trim();
  if (!normalized) return null;
  const matched = listServiceBootstrapCatalogEntries().find((entry) =>
    (entry.default_for_surfaces || []).includes(normalized)
  );
  return matched?.service_id || null;
}
