import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MediaDrawioBoundaryPaletteOverrideEntry {
  boundary?: string;
  type?: string;
  tier?: string;
  name_contains?: string;
  fill: string;
  stroke: string;
}

export interface MediaDrawioBoundaryIconRuleEntry {
  boundary?: string;
  type?: string;
  tier?: string;
  name_contains?: string;
  icons: string[];
}

interface MediaDrawioBoundaryPolicyCatalog {
  version: string;
  palette_overrides: MediaDrawioBoundaryPaletteOverrideEntry[];
  icon_rules: MediaDrawioBoundaryIconRuleEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-boundary-policy.json');
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/media-drawio-boundary-policy.schema.json'
);

const catalog = defineCatalog<MediaDrawioBoundaryPolicyCatalog>({
  id: 'media-drawio-boundary-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaDrawioBoundaryPolicyCatalog(): MediaDrawioBoundaryPolicyCatalog {
  return catalog.load();
}

export function resolveDrawioBoundaryPaletteOverride(input: {
  boundary: string;
  type?: string;
  tier?: string;
  name?: string;
}): { fill: string; stroke: string } | null {
  const boundary = String(input.boundary || '')
    .trim()
    .toLowerCase();
  const type = String(input.type || '')
    .trim()
    .toLowerCase();
  const tier = String(input.tier || '')
    .trim()
    .toLowerCase();
  const name = String(input.name || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioBoundaryPolicyCatalog();
  const matched = catalog.palette_overrides.find(
    (entry) =>
      (!entry.boundary || entry.boundary === boundary) &&
      (!entry.type || entry.type === type) &&
      (!entry.tier || entry.tier === tier) &&
      (!entry.name_contains || name.includes(entry.name_contains))
  );
  return matched ? { fill: matched.fill, stroke: matched.stroke } : null;
}

export function resolveDrawioBoundaryIconCandidates(input: {
  boundary: string;
  type?: string;
  tier?: string;
  name?: string;
}): string[] {
  const boundary = String(input.boundary || '')
    .trim()
    .toLowerCase();
  const type = String(input.type || '')
    .trim()
    .toLowerCase();
  const tier = String(input.tier || '')
    .trim()
    .toLowerCase();
  const name = String(input.name || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioBoundaryPolicyCatalog();
  const matched = catalog.icon_rules.find(
    (entry) =>
      (!entry.boundary || entry.boundary === boundary) &&
      (!entry.type || entry.type === type) &&
      (!entry.tier || entry.tier === tier) &&
      (!entry.name_contains || name.includes(entry.name_contains))
  );
  return matched?.icons || [];
}
