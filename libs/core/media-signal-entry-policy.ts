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

const FALLBACK_ENTRY_TYPES: MediaSignalEntryPolicyItem[] = [
  {
    source_key: 'signals',
    signal_type: 'signal',
    default_tone: 'info',
    title_fields: ['title', 'name', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'tone', 'state'],
  },
  {
    source_key: 'risks',
    signal_type: 'risk',
    default_tone: 'warning',
    title_fields: ['title', 'name', 'risk', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
  {
    source_key: 'incidents',
    signal_type: 'incident',
    default_tone: 'danger',
    title_fields: ['title', 'name', 'incident', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
  {
    source_key: 'controls',
    signal_type: 'control',
    default_tone: 'info',
    title_fields: ['title', 'name', 'control', 'summary'],
    owner_fields: ['owner', 'assignee', 'team', 'function'],
    status_fields: ['status', 'severity', 'tone', 'state'],
  },
];

const FALLBACK_CATALOG_META = {
  sheet_title: 'Signals and Risks',
  columns: ['Task', 'Owner', 'Status'],
  empty_message: 'No elevated signals detected.',
  elevated_tones: ['warning', 'danger'],
  elevated_status_keywords: ['risk', 'blocked', 'late', 'issue'],
};

const catalog = defineCatalog<MediaSignalEntryPolicyCatalog>({
  id: 'media-signal-entry-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: {
    version: '1.0.0',
    ...FALLBACK_CATALOG_META,
    entry_types: FALLBACK_ENTRY_TYPES,
  },
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

export function resetMediaSignalEntryPolicyCatalogCache(): void {
  catalog.reset();
}
