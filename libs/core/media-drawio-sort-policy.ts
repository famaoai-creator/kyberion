import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

interface MediaDrawioSortPolicyCatalog {
  version: string;
  group_order: string[];
  type_order: string[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-drawio-sort-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-drawio-sort-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaDrawioSortPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MediaDrawioSortPolicyCatalog = {
  version: '1.0.0',
  group_order: ['edge', 'web', 'application', 'app', 'data', 'database', 'network', 'security', 'module', 'control', 'state'],
  type_order: [
    'aws_provider',
    'aws_availability_zones',
    'terraform_remote_state',
    'aws_internet_gateway',
    'aws_nat_gateway',
    'aws_route_table',
    'aws_security_group',
    'aws_security_group_rule',
    'aws_elb',
    'aws_lb',
    'aws_launch_configuration',
    'aws_autoscaling_group',
    'aws_db_instance',
    'aws_rds_instance',
    'aws_s3_bucket',
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

function validateCatalog(value: unknown, label: string): MediaDrawioSortPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media drawio sort policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaDrawioSortPolicyCatalog;
}

export function loadMediaDrawioSortPolicyCatalog(): MediaDrawioSortPolicyCatalog {
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

export function resolveMediaDrawioGroupRank(group?: string): number {
  const normalized = String(group || '').trim().toLowerCase();
  const catalog = loadMediaDrawioSortPolicyCatalog();
  const index = catalog.group_order.indexOf(normalized);
  return index >= 0 ? index : catalog.group_order.length;
}

export function resolveMediaDrawioTypeRank(type?: string): number {
  const normalized = String(type || '').trim();
  const catalog = loadMediaDrawioSortPolicyCatalog();
  const index = catalog.type_order.indexOf(normalized);
  return index >= 0 ? index : catalog.type_order.length;
}

export function resetMediaDrawioSortPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
