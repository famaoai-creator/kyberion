import { pathResolver } from '../path-resolver.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { assertSafeRepositoryPath } from '../secure-io.js';

export interface ActuatorExampleRecord {
  id: string;
  title: string;
  path: string;
  description: string;
  tags?: string[];
}

export interface ActuatorExampleCatalog {
  actuator: string;
  examples: ActuatorExampleRecord[];
}

const ACTUATOR_EXAMPLE_CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/actuator-example-catalog.schema.json'
);
const catalogCache = new Map<string, GovernedCatalog<ActuatorExampleCatalog>>();

export function loadActuatorExampleCatalog(catalogPath: string): ActuatorExampleCatalog {
  const safeCatalogPath = assertSafeRepositoryPath(catalogPath, { allowMissingLeaf: true });
  let catalog = catalogCache.get(safeCatalogPath);
  if (!catalog) {
    catalog = defineCatalog<ActuatorExampleCatalog>({
      id: 'actuator-example-catalog',
      path: safeCatalogPath,
      schema: ACTUATOR_EXAMPLE_CATALOG_SCHEMA_PATH,
    });
    catalogCache.set(safeCatalogPath, catalog);
  }
  return catalog.load();
}
