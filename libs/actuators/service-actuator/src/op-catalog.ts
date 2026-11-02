import { withCatalogInputContract } from '@agent/core/actuator/actuator-sdk';

// AR-02: self-described op catalog replacing the hand-curated registry
// entry, which listed ops this actuator never dispatched (list/read/log/
// notify came from the shared pools anyway) while omitting the real op
// surface. Removed curated ops fall back to the shared pools with the same
// kind, so step-type inference is unchanged; the added ops were previously
// unclassifiable (pipelines reach them via explicit role today).

import type { PipelineStepType } from '@agent/core/actuator/actuator-op-registry';
import type { ActuatorOpDescription } from '@agent/core/actuator/actuator-sdk';

const SERVICE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    auth: { type: 'string', enum: ['none', 'secret-guard', 'session'] },
    context: { type: 'object', additionalProperties: true },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
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

function toSpec(op: string, kind: PipelineStepType) {
  return withCatalogInputContract('service', op, kind, {
    op,
    kind,
    input_schema: SERVICE_SCHEMA,
    examples: SERVICE_EXAMPLE,
  });
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    {
      op: 'information_asset_work',
      kind: 'apply',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['work_item_id', 'attempt_id', 'lease_id', 'dot_id', 'actor_id'],
        properties: Object.fromEntries(
          ['work_item_id', 'attempt_id', 'lease_id', 'dot_id', 'actor_id'].map((key) => [
            key,
            { type: 'string', minLength: 1 },
          ])
        ),
      },
      examples: [
        {
          work_item_id: 'work-example',
          attempt_id: 'attempt-example',
          lease_id: 'lease-example',
          dot_id: 'inbox-dot',
          actor_id: 'dot:inbox-dot',
        },
      ],
    },
    ...SERVICE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SERVICE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SERVICE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
