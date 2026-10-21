import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

interface RuntimeControlPolicy {
  version: 1;
  surface_auth: {
    window_ms: number;
    client_limit: number;
    surface_limit: number;
    max_keys: number;
  };
  concierge: { window_ms: number; read_limit: number; mutation_limit: number; max_keys: number };
  presence_studio: {
    window_ms: number;
    read_limit: number;
    mutation_limit: number;
    max_keys: number;
  };
  chronos: { window_ms: number; limit: number; max_keys: number };
  bridge_errors: { window_ms: number; max_keys: number };
  operator_notifications: { window_ms: number; max_keys: number };
  schedule_failures: {
    threshold: number;
    reset: 'never';
    reset_on_success: true;
    action: 'disable';
  };
}

let catalog: ReturnType<typeof defineCatalog<RuntimeControlPolicy>> | undefined;
let catalogPath: string | undefined;

export function loadRuntimeControlPolicy(): RuntimeControlPolicy {
  // Loading core exports must never touch a runtime catalog. Resolve both paths
  // at the actual operation boundary, including after a runtime-root change.
  const currentPath = pathResolver.knowledge('product/governance/runtime-control-policy.json');
  if (!catalog || catalogPath !== currentPath) {
    catalog = defineCatalog<RuntimeControlPolicy>({
      id: 'runtime-control-policy',
      path: currentPath,
      schema: pathResolver.knowledge('product/schemas/runtime-control-policy.schema.json'),
    });
    catalogPath = currentPath;
  }
  return catalog.load();
}
