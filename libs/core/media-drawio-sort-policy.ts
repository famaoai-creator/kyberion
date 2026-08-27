import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface MediaDrawioSortPolicyCatalog {
  version: string;
  group_order: string[];
  type_order: string[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-sort-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-sort-policy.schema.json');

const FALLBACK_CATALOG: MediaDrawioSortPolicyCatalog = {
  version: '1.0.0',
  group_order: [
    'edge',
    'web',
    'application',
    'app',
    'data',
    'database',
    'network',
    'security',
    'module',
    'control',
    'state',
  ],
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

const catalog = defineCatalog<MediaDrawioSortPolicyCatalog>({
  id: 'media-drawio-sort-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadMediaDrawioSortPolicyCatalog(): MediaDrawioSortPolicyCatalog {
  return catalog.load();
}

export function resolveMediaDrawioGroupRank(group?: string): number {
  const normalized = String(group || '')
    .trim()
    .toLowerCase();
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
  catalog.reset();
}
