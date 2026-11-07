import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalog } from '@agent/core/foundation/governed-catalog';

interface MediaDrawioSecurityGroupOrderCatalog {
  version: string;
  relation_prefix: string;
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/media-drawio-security-group-order.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/media-drawio-security-group-order.schema.json'
);

const catalog = defineCatalog<MediaDrawioSecurityGroupOrderCatalog>({
  id: 'media-drawio-security-group-order',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaDrawioSecurityGroupOrderCatalog(): MediaDrawioSecurityGroupOrderCatalog {
  return catalog.load();
}

export function resolveMediaDrawioSecurityGroupRelationPrefix(): string {
  return loadMediaDrawioSecurityGroupOrderCatalog().relation_prefix;
}
