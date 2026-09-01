import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { recordConfigFallback } from './config-fallback-registry.js';
import { resolveDrawioBoundaryPaletteOverride } from './media-drawio-boundary-policy.js';

export interface MediaDrawioBoundaryPaletteEntry {
  boundary: string;
  type?: string;
  fill: string;
  stroke: string;
}

export interface MediaDrawioNodeSizeEntry {
  type?: string;
  tier?: string;
  width: number;
  height: number;
}

interface MediaDrawioPolicyCatalog {
  version: string;
  boundary_palettes: MediaDrawioBoundaryPaletteEntry[];
  node_sizes: MediaDrawioNodeSizeEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-policy.schema.json');

const FALLBACK_BOUNDARY_PALETTES: MediaDrawioBoundaryPaletteEntry[] = [
  { boundary: 'account', type: 'aws_account', fill: '#F8FAFC', stroke: '#0F172A' },
  { boundary: 'region', type: 'aws_region', fill: '#EFF6FF', stroke: '#1D4ED8' },
  { boundary: 'vpc', type: 'aws_vpc', fill: '#FFF7ED', stroke: '#C2410C' },
  { boundary: 'az', type: 'aws_availability_zone', fill: '#F9FAFB', stroke: '#6B7280' },
];

const FALLBACK_NODE_SIZES: MediaDrawioNodeSizeEntry[] = [
  { type: 'terraform_module', width: 196, height: 112 },
  { tier: 'edge', width: 92, height: 92 },
  { tier: 'data', width: 92, height: 92 },
  { tier: 'security', width: 80, height: 80 },
  { tier: 'control', width: 80, height: 80 },
  { tier: 'network', width: 80, height: 80 },
  { tier: 'web', width: 88, height: 88 },
  { tier: 'application', width: 88, height: 88 },
  { tier: 'app', width: 88, height: 88 },
];

const catalog = defineCatalog<MediaDrawioPolicyCatalog>({
  id: 'media-drawio-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: () => ({
    version: '1.0.0',
    boundary_palettes: FALLBACK_BOUNDARY_PALETTES,
    node_sizes: FALLBACK_NODE_SIZES,
  }),
  onFallback: (error, fallback) =>
    recordConfigFallback({ knowledgePath: CATALOG_PATH, error, defaults: fallback }),
});

export function loadMediaDrawioPolicyCatalog(): MediaDrawioPolicyCatalog {
  return catalog.load();
}

export function resolveMediaDrawioBoundaryPalette(input: {
  boundary: string;
  type?: string;
  name?: string;
  fallbackFill: string;
  fallbackStroke: string;
}): { fill: string; stroke: string } {
  const normalizedBoundary = String(input.boundary || '').trim();
  const normalizedType = String(input.type || '').trim();
  const normalizedName = String(input.name || '')
    .trim()
    .toLowerCase();
  const override = resolveDrawioBoundaryPaletteOverride({
    boundary: normalizedBoundary,
    type: normalizedType,
    name: normalizedName,
  });
  if (override) return override;
  const catalog = loadMediaDrawioPolicyCatalog();

  const palette = catalog.boundary_palettes.find(
    (entry) =>
      (entry.boundary === normalizedBoundary && (!entry.type || entry.type === normalizedType)) ||
      (entry.type === normalizedType && !entry.boundary)
  );
  if (palette) return { fill: palette.fill, stroke: palette.stroke };

  const fallback = catalog.boundary_palettes.find((entry) => entry.boundary === normalizedBoundary);
  if (fallback) return { fill: fallback.fill, stroke: fallback.stroke };
  return { fill: input.fallbackFill, stroke: input.fallbackStroke };
}

export function resolveMediaDrawioNodeSize(input: {
  type?: string;
  tier?: string;
}): { width: number; height: number } | null {
  const normalizedType = String(input.type || '').trim();
  const normalizedTier = String(input.tier || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioPolicyCatalog();
  const match = catalog.node_sizes.find(
    (entry) =>
      (entry.type && entry.type === normalizedType) || (entry.tier && entry.tier === normalizedTier)
  );
  return match ? { width: match.width, height: match.height } : null;
}
