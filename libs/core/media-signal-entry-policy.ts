import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MediaSignalEntryPolicyItem {
  source_key: string;
  signal_type: string;
  default_tone: string;
  title_fields: string[];
  owner_fields: string[];
  status_fields: string[];
}

interface MediaSignalEntryPolicyCatalog {
  version: string;
  sheet_title: string;
  columns: string[];
  empty_message: string;
  elevated_tones: string[];
  elevated_status_keywords: string[];
  entry_types: MediaSignalEntryPolicyItem[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-signal-entry-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-signal-entry-policy.schema.json');

const catalog = defineCatalog<MediaSignalEntryPolicyCatalog>({
  id: 'media-signal-entry-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaSignalEntryPolicyCatalog(): MediaSignalEntryPolicyCatalog {
  return catalog.load();
}

export function resolveMediaSignalEntryPolicy(
  sourceKey: string
): MediaSignalEntryPolicyItem | null {
  const normalized = String(sourceKey || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const catalog = loadMediaSignalEntryPolicyCatalog();
  return catalog.entry_types.find((entry) => entry.source_key === normalized) || null;
}
