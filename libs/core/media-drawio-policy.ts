import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
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

const catalog = defineCatalog<MediaDrawioPolicyCatalog>({
  id: 'media-drawio-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
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
