export interface Endpoint {
  path: string;
  method: string;
  deprecated: boolean;
  parameters: number;
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
        parameters: (config.parameters || []).length,
      });
    }
  }
  return endpoints;
}
