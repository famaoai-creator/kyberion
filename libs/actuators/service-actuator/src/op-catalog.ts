import { withCatalogInputContract } from '@agent/core';

// AR-02: self-described op catalog replacing the hand-curated registry
// entry, which listed ops this actuator never dispatched (list/read/log/
// notify came from the shared pools anyway) while omitting the real op
// surface. Removed curated ops fall back to the shared pools with the same
// kind, so step-type inference is unchanged; the added ops were previously
// unclassifiable (pipelines reach them via explicit role today).

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const SERVICE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    auth: { type: 'string', enum: ['none', 'secret-guard', 'session'] },
    context: { type: 'object', additionalProperties: true },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
    params: { type: 'object', additionalProperties: true },
    service_id: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: false,
  required: ['service_id', 'action'],
} as const;

const SERVICE_EXAMPLE = [
  {
    service_id: 'backlog',
    action: 'list_issues',
    params: { project_id: 'demo' },
    auth: 'secret-guard',
  },
];

export const SERVICE_ACTUATOR_CAPTURE_OPS = ['preset', 'harness'] as const;

export const SERVICE_ACTUATOR_TRANSFORM_OPS = [] as const;

export const SERVICE_ACTUATOR_APPLY_OPS = ['api', 'cli', 'mcp', 'oauth', 'reconcile'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return withCatalogInputContract('service', op, kind, {
    op,
    kind,
    input_schema: SERVICE_SCHEMA,
    examples: SERVICE_EXAMPLE,
  });
}

export function describeOps() {
  return [
    ...SERVICE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SERVICE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SERVICE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
