export interface Endpoint {
  path: string;
  method: string;
  deprecated: boolean;
  parameters: string[];
}

export function extractEndpoints(spec: any): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const paths = spec.paths || {};
  for (const [p, methods] of Object.entries(paths)) {
    for (const [method, config] of Object.entries<any>(methods as any)) {
      endpoints.push({
        path: p,
        method: method.toUpperCase(),
        deprecated: !!config.deprecated,
        parameters: (config.parameters || []).map((p: any) => p.name),
      });
    }
  }
  return endpoints;
}

export interface BreakingChange {
  type: 'REMOVED_ENDPOINT' | 'REMOVED_PARAMETER' | 'REQUIRED_PARAMETER';
  description: string;
  path: string;
}

/**
 * Compares two API specs and detects potential breaking changes.
 */
export function detectBreakingChanges(oldSpec: any, newSpec: any): BreakingChange[] {
  const oldEndpoints = extractEndpoints(oldSpec);
  const newEndpoints = extractEndpoints(newSpec);
  const changes: BreakingChange[] = [];

  for (const oldEp of oldEndpoints) {
    const newEp = newEndpoints.find(e => e.path === oldEp.path && e.method === oldEp.method);
    
    if (!newEp) {
      changes.push({
        type: 'REMOVED_ENDPOINT',
        description: `Endpoint ${oldEp.method} ${oldEp.path} was removed.`,
        path: oldEp.path
      });
      continue;
    }

    // Check for removed parameters
    for (const oldParam of oldEp.parameters) {
      if (!newEp.parameters.includes(oldParam)) {
        changes.push({
          type: 'REMOVED_PARAMETER',
          description: `Parameter '${oldParam}' was removed from ${oldEp.method} ${oldEp.path}.`,
          path: oldEp.path
        });
      }
    }
  }

  return changes;
}
