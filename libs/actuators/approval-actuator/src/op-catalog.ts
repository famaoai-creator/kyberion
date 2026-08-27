// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in approval-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const APPROVAL_PROPERTIES = {
  channel: { type: 'string' },
  storageChannel: { type: 'string' },
  threadTs: { type: 'string' },
  correlationId: { type: 'string' },
  requestedBy: { type: 'string' },
  draft: { type: 'object' },
  sourceText: { type: 'string' },
  requestId: { type: 'string' },
  decision: { enum: ['approved', 'rejected'] },
  decidedBy: { type: 'string' },
  decidedByRole: { type: 'string' },
  authMethod: { enum: ['surface_session', 'totp', 'passkey', 'manual'] },
  decidedByType: { enum: ['human', 'ai_agent', 'service'] },
  authenticated: { type: 'boolean' },
  payloadHash: { type: 'string' },
  effectBinding: { type: 'string' },
  note: { type: 'string' },
  reasonCategory: { type: 'string' },
  requestKind: { enum: ['channel-approval', 'secret_mutation', 'mission_gate'] },
  expiresAt: { type: 'string', format: 'date-time' },
  requestedByContext: { type: 'object' },
  target: { type: 'object' },
  justification: { type: 'object' },
  risk: { type: 'object' },
  workflow: { type: 'object' },
  role: { type: 'string' },
  operation_id: { type: 'string' },
  correlation_id: { type: 'string' },
  decision_type: { type: 'string' },
  agent_id: { type: 'string' },
  caller_role: { type: 'string' },
  amount: { type: 'number' },
  tenant_slug: { type: 'string' },
  mission_id: { type: 'string' },
  title: { type: 'string' },
  summary: { type: 'string' },
  topic: { type: 'string' },
  idempotency_key: { type: 'string' },
  reason: { type: 'string' },
  evidence: {},
  severity: { enum: ['low', 'medium', 'high'] },
} as const;

const APPROVAL_SCHEMA = {
  type: 'object',
  properties: APPROVAL_PROPERTIES,
  additionalProperties: false,
} as const;

const APPROVAL_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  load: [{ channel: 'mission', requestId: 'approval-1' }],
  list_pending: [{ channel: 'mission' }],
  create: [
    {
      channel: 'mission',
      threadTs: '2026-08-26T10:00:00+09:00',
      correlationId: 'corr-1',
      requestedBy: 'mission_controller',
      draft: { title: 'Review', summary: 'Human approval required', severity: 'medium' },
    },
  ],
  decide: [
    { channel: 'mission', requestId: 'approval-1', decision: 'approved', decidedBy: 'operator' },
  ],
  evaluate_decision_rights: [
    { operation_id: 'secret.rotate', correlation_id: 'corr-1', decision_type: 'secret_mutation' },
  ],
  request_review: [{ topic: 'Review artifact', idempotency_key: 'review-1' }],
};

export const APPROVAL_ACTUATOR_CAPTURE_OPS = ['load', 'list_pending'] as const;

export const APPROVAL_ACTUATOR_TRANSFORM_OPS = [] as const;

export const APPROVAL_ACTUATOR_APPLY_OPS = [
  'create',
  'decide',
  'evaluate_decision_rights',
  'request_review',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  const required =
    op === 'load'
      ? ['channel', 'requestId']
      : op === 'list_pending'
        ? ['channel']
        : op === 'create'
          ? ['channel', 'threadTs', 'correlationId', 'requestedBy', 'draft']
          : op === 'decide'
            ? ['channel', 'requestId', 'decision', 'decidedBy']
            : op === 'evaluate_decision_rights'
              ? ['operation_id', 'correlation_id', 'decision_type']
              : ['topic', 'idempotency_key'];
  return {
    op,
    kind,
    input_schema: { ...APPROVAL_SCHEMA, required },
    examples: APPROVAL_EXAMPLES[op],
  };
}

export function describeOps() {
  return [
    ...APPROVAL_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...APPROVAL_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...APPROVAL_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
