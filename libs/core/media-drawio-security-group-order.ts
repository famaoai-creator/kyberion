import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

interface MediaDrawioSecurityGroupOrderCatalog {
  version: string;
  relation_prefix: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/media-drawio-security-group-order.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/media-drawio-security-group-order.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaDrawioSecurityGroupOrderCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: MediaDrawioSecurityGroupOrderCatalog = {
  version: '1.0.0',
  relation_prefix: 'aws_security_group.',
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

function validateCatalog(value: unknown, label: string): MediaDrawioSecurityGroupOrderCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media drawio security group order catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaDrawioSecurityGroupOrderCatalog;
}

export function loadMediaDrawioSecurityGroupOrderCatalog(): MediaDrawioSecurityGroupOrderCatalog {
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

export function resolveMediaDrawioSecurityGroupRelationPrefix(): string {
  return loadMediaDrawioSecurityGroupOrderCatalog().relation_prefix;
}

export function resetMediaDrawioSecurityGroupOrderCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
