import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MediaDrawioEdgeLabelPolicyEntry {
  label: string;
  style_parts: string[];
}

export interface MediaDrawioEdgeRoutingPolicyEntry {
  rule: 'security_to_web' | 'horizontal';
  source_tiers?: string[];
  target_tiers?: string[];
}

interface MediaDrawioEdgePolicyCatalog {
  version: string;
  edge_labels: MediaDrawioEdgeLabelPolicyEntry[];
  routing_rules: MediaDrawioEdgeRoutingPolicyEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-edge-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-edge-policy.schema.json');

const FALLBACK_CATALOG: MediaDrawioEdgePolicyCatalog = {
  version: '1.0.0',
  edge_labels: [
    {
      label: 'uses',
      style_parts: ['dashed=1', 'strokeOpacity=55'],
    },
    {
      label: 'source',
      style_parts: [
        'dashed=1',
        'strokeWidth=2',
        'endArrow=open',
        'endFill=0',
        'labelBackgroundColor=#FFF7ED',
      ],
    },
    {
      label: 'expands',
      style_parts: [
        'dashed=1',
        'dashPattern=8 4',
        'strokeWidth=2',
        'endArrow=block',
        'endFill=1',
        'labelBackgroundColor=#EFF6FF',
      ],
    },
  ],
  routing_rules: [
    {
      rule: 'security_to_web',
      source_tiers: ['security'],
      target_tiers: ['web', 'application', 'app'],
    },
    {
      rule: 'horizontal',
      source_tiers: ['edge', 'web', 'application', 'app', 'data', 'security'],
      target_tiers: ['edge', 'web', 'application', 'app', 'data', 'security'],
    },
  ],
};

const catalog = defineCatalog<MediaDrawioEdgePolicyCatalog>({
  id: 'media-drawio-edge-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadMediaDrawioEdgePolicyCatalog(): MediaDrawioEdgePolicyCatalog {
  return catalog.load();
}

export function resolveDrawioEdgeLabelStyleParts(label?: string): string[] {
  const normalized = String(label || '').trim();
  if (!normalized) return [];
  const catalog = loadMediaDrawioEdgePolicyCatalog();
  return catalog.edge_labels.find((entry) => entry.label === normalized)?.style_parts || [];
}

export function resolveDrawioEdgeRoutingStyleParts(input: {
  sourceTier: string;
  targetTier: string;
}): string[] {
  const sourceTier = String(input.sourceTier || '')
    .trim()
    .toLowerCase();
  const targetTier = String(input.targetTier || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioEdgePolicyCatalog();
  if (
    catalog.routing_rules.some(
      (entry) =>
        entry.rule === 'security_to_web' &&
        entry.source_tiers?.includes(sourceTier) &&
        entry.target_tiers?.includes(targetTier)
    )
  ) {
    return ['exitX=0', 'exitY=0.5', 'entryX=1', 'entryY=0.5'];
  }
  if (
    catalog.routing_rules.some(
      (entry) =>
        entry.rule === 'horizontal' &&
        entry.source_tiers?.includes(sourceTier) &&
        entry.target_tiers?.includes(targetTier) &&
        sourceTier !== targetTier
    )
  ) {
    return ['exitX=1', 'exitY=0.5', 'entryX=0', 'entryY=0.5'];
  }
  return [];
}

export function resetMediaDrawioEdgePolicyCatalogCache(): void {
  catalog.reset();
}
