import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-drawio-boundary-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-drawio-boundary-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaDrawioBoundaryPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MediaDrawioBoundaryPolicyCatalog = {
  version: '1.0.0',
  palette_overrides: [
    { boundary: 'lane', tier: 'edge', fill: '#ECFDF5', stroke: '#059669' },
    { boundary: 'lane', tier: 'network', fill: '#F0F9FF', stroke: '#0284C7' },
    { boundary: 'lane', tier: 'web', fill: '#FFF7ED', stroke: '#EA580C' },
    { boundary: 'lane', tier: 'application', fill: '#FFF7ED', stroke: '#EA580C' },
    { boundary: 'lane', tier: 'app', fill: '#FFF7ED', stroke: '#EA580C' },
    { boundary: 'lane', tier: 'security', fill: '#FEF2F2', stroke: '#DC2626' },
    { boundary: 'lane', tier: 'data', fill: '#EFF6FF', stroke: '#2563EB' },
    { boundary: 'lane', tier: 'database', fill: '#EFF6FF', stroke: '#2563EB' },
    { boundary: 'lane', tier: 'control', fill: '#F8FAFC', stroke: '#64748B' },
    { boundary: 'lane', tier: 'state', fill: '#F8FAFC', stroke: '#64748B' },
    { boundary: 'scope', tier: 'state', fill: '#F8FAFC', stroke: '#475569' },
    { boundary: 'scope', tier: 'data', fill: '#EFF6FF', stroke: '#2563EB' },
    { boundary: 'scope', tier: 'web', fill: '#FFF7ED', stroke: '#C2410C' },
    { boundary: 'scope', tier: 'module', fill: '#FFF7ED', stroke: '#C2410C' },
    { boundary: 'scope', tier: 'network', fill: '#F0F9FF', stroke: '#0284C7' },
    { boundary: 'subnet', name_contains: 'public', fill: '#ECFDF5', stroke: '#059669' },
    { boundary: 'subnet', name_contains: 'data', fill: '#FEF2F2', stroke: '#DC2626' },
    { boundary: 'subnet', fill: '#FFF7ED', stroke: '#EA580C' },
  ],
  icon_rules: [
    {
      boundary: 'account',
      type: 'aws_account',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Account_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Account_32.svg',
      ],
    },
    {
      boundary: 'region',
      type: 'aws_region',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.svg',
      ],
    },
    {
      boundary: 'vpc',
      type: 'aws_vpc',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.svg',
      ],
    },
    {
      boundary: 'subnet',
      type: 'aws_subnet',
      name_contains: 'public',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.svg',
      ],
    },
    {
      boundary: 'subnet',
      type: 'aws_subnet',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.svg',
      ],
    },
    {
      boundary: 'az',
      type: 'aws_availability_zone',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.svg',
      ],
    },
    {
      boundary: 'scope',
      tier: 'state',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.svg',
      ],
    },
    {
      boundary: 'scope',
      tier: 'data',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.svg',
      ],
    },
    {
      boundary: 'scope',
      tier: 'web',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.svg',
      ],
    },
    {
      boundary: 'scope',
      tier: 'module',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.svg',
      ],
    },
    {
      boundary: 'scope',
      tier: 'network',
      icons: [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud-logo_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud-logo_32.svg',
      ],
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

function validateCatalog(value: unknown, label: string): MediaDrawioBoundaryPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media drawio boundary policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaDrawioBoundaryPolicyCatalog;
}

export function loadMediaDrawioBoundaryPolicyCatalog(): MediaDrawioBoundaryPolicyCatalog {
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

export function resolveDrawioBoundaryPaletteOverride(input: {
  boundary: string;
  type?: string;
  tier?: string;
  name?: string;
}): { fill: string; stroke: string } | null {
  const boundary = String(input.boundary || '').trim().toLowerCase();
  const type = String(input.type || '').trim().toLowerCase();
  const tier = String(input.tier || '').trim().toLowerCase();
  const name = String(input.name || '').trim().toLowerCase();
  const catalog = loadMediaDrawioBoundaryPolicyCatalog();
  const matched = catalog.palette_overrides.find((entry) =>
    (!entry.boundary || entry.boundary === boundary)
      && (!entry.type || entry.type === type)
      && (!entry.tier || entry.tier === tier)
      && (!entry.name_contains || name.includes(entry.name_contains))
  );
  return matched ? { fill: matched.fill, stroke: matched.stroke } : null;
}

export function resolveDrawioBoundaryIconCandidates(input: {
  boundary: string;
  type?: string;
  tier?: string;
  name?: string;
}): string[] {
  const boundary = String(input.boundary || '').trim().toLowerCase();
  const type = String(input.type || '').trim().toLowerCase();
  const tier = String(input.tier || '').trim().toLowerCase();
  const name = String(input.name || '').trim().toLowerCase();
  const catalog = loadMediaDrawioBoundaryPolicyCatalog();
  const matched = catalog.icon_rules.find((entry) =>
    (!entry.boundary || entry.boundary === boundary)
      && (!entry.type || entry.type === type)
      && (!entry.tier || entry.tier === tier)
      && (!entry.name_contains || name.includes(entry.name_contains))
  );
  return matched?.icons || [];
}

export function resetMediaDrawioBoundaryPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
