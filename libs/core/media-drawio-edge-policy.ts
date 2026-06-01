import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-drawio-edge-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-drawio-edge-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaDrawioEdgePolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

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

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): MediaDrawioEdgePolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media drawio edge policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaDrawioEdgePolicyCatalog;
}

export function loadMediaDrawioEdgePolicyCatalog(): MediaDrawioEdgePolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = FALLBACK_CATALOG;
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
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
  const sourceTier = String(input.sourceTier || '').trim().toLowerCase();
  const targetTier = String(input.targetTier || '').trim().toLowerCase();
  const catalog = loadMediaDrawioEdgePolicyCatalog();
  if (
    catalog.routing_rules.some(
      (entry) =>
        entry.rule === 'security_to_web' &&
        entry.source_tiers?.includes(sourceTier) &&
        entry.target_tiers?.includes(targetTier),
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
        sourceTier !== targetTier,
    )
  ) {
    return ['exitX=1', 'exitY=0.5', 'entryX=0', 'entryY=0.5'];
  }
  return [];
}

export function resetMediaDrawioEdgePolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
