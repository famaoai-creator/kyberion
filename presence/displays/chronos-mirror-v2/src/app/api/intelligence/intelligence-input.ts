import { isRecord } from '@agent/core/foundation';

const ACTION_FIELDS: Record<string, readonly string[]> = {
  approval_decision: [
    'action',
    'requestId',
    'storageChannel',
    'channel',
    'decision',
    'note',
    'reasonCategory',
    'tenant',
  ],
  memory_promote_candidate: ['action', 'candidateId', 'tenant'],
  memory_approve_candidate: ['action', 'candidateId', 'tenant'],
  memory_reject_candidate: ['action', 'candidateId', 'tenant', 'note'],
  distill_candidate_decision: ['action', 'candidateId', 'decision', 'tenant'],
  memory_promote_pending: ['action', 'tenant', 'dryRun', 'supersedes'],
  next_action_execute: ['action', 'actionId', 'operation', 'outcome', 'target', 'detail'],
  close_browser_session: ['action', 'sessionId', 'tenant'],
  restart_browser_session: ['action', 'sessionId', 'tenant'],
  promote_mission_seed: ['action', 'seedId', 'tenant'],
  create_track_seed: ['action', 'trackId', 'artifactId', 'tenant'],
  mission_control: ['action', 'missionId', 'operation', 'tenant'],
  intervention_respond: ['action', 'missionId', 'response', 'question', 'tenant'],
  surface_control: ['action', 'surfaceId', 'operation'],
  clear_surface_outbox: ['action', 'surface', 'messageId', 'tenant'],
  cleanup_runtime_lease: ['action', 'agentId', 'tenant'],
  restart_runtime_lease: ['action', 'agentId', 'tenant'],
} as const;

const ACTIONS = new Set(Object.keys(ACTION_FIELDS));
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SURFACES = new Set(['chronos', 'slack']);
const APPROVAL_DECISIONS = new Set(['approved', 'rejected']);
const DISTILL_DECISIONS = new Set(['promote', 'archive']);
const NEXT_ACTION_OUTCOMES = new Set(['completed', 'failed']);
const MISSION_OPERATIONS = new Set([
  'resume',
  'pause',
  'cancel',
  'refresh_team',
  'prewarm_team',
  'staff_team',
  'finish',
]);
const SURFACE_OPERATIONS = new Set(['reconcile', 'status', 'start', 'stop']);

const STRING_LIMITS: Record<string, number> = {
  requestId: 256,
  storageChannel: 128,
  channel: 128,
  candidateId: 256,
  actionId: 256,
  operation: 128,
  target: 256,
  detail: 20_000,
  sessionId: 256,
  seedId: 256,
  trackId: 256,
  artifactId: 256,
  missionId: 256,
  response: 20_000,
  question: 20_000,
  surfaceId: 256,
  messageId: 256,
  agentId: 256,
  tenant: 128,
  note: 2_000,
  reasonCategory: 128,
  supersedes: 256,
};

export type ChronosIntelligenceAction = keyof typeof ACTION_FIELDS;

export interface ChronosIntelligenceInput extends Record<string, unknown> {
  action: ChronosIntelligenceAction;
}

function requireString(body: Record<string, unknown>, field: string, options = {}): string {
  const value = body[field];
  const limit = STRING_LIMITS[field] ?? 256;
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) {
    throw new Error(`${field} must be a non-empty string up to ${limit} characters`);
  }
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} must not contain control characters`);
  if (
    options &&
    typeof options === 'object' &&
    'identifier' in options &&
    !SAFE_IDENTIFIER.test(value.trim())
  ) {
    throw new Error(`${field} must be a safe identifier`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): void {
  const value = body[field];
  if (value === undefined) return;
  const limit = STRING_LIMITS[field] ?? 256;
  if (typeof value !== 'string' || value.length > limit) {
    throw new Error(`${field} must be a string up to ${limit} characters`);
  }
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} must not contain control characters`);
}

function requireEnum(body: Record<string, unknown>, field: string, allowed: Set<string>): string {
  const value = requireString(body, field);
  if (!allowed.has(value)) throw new Error(`${field} has an unsupported value`);
  return value;
}

function requireIdentifier(body: Record<string, unknown>, field: string): string {
  return requireString(body, field, { identifier: true });
}

function validateActionFields(body: Record<string, unknown>, action: ChronosIntelligenceAction) {
  const allowed = new Set(ACTION_FIELDS[action]);
  const unexpected = Object.keys(body).find((field) => !allowed.has(field));
  if (unexpected) throw new Error(`unexpected intelligence field: ${unexpected}`);

  for (const field of allowed) {
    if (field === 'action' || body[field] === undefined) continue;
    if (field === 'surfaceId' && body[field] === null) continue;
    optionalString(body, field);
  }
}

export function parseChronosIntelligenceInput(value: unknown): ChronosIntelligenceInput {
  if (!isRecord(value)) throw new Error('Chronos intelligence body must be an object');
  const actionValue = value.action;
  if (typeof actionValue !== 'string' || !ACTIONS.has(actionValue)) {
    throw new Error('Unsupported action');
  }
  const action = actionValue as ChronosIntelligenceAction;
  validateActionFields(value, action);

  switch (action) {
    case 'approval_decision':
      requireIdentifier(value, 'requestId');
      requireString(value, 'storageChannel');
      requireString(value, 'channel');
      requireEnum(value, 'decision', APPROVAL_DECISIONS);
      break;
    case 'memory_promote_candidate':
    case 'memory_approve_candidate':
    case 'memory_reject_candidate':
      requireIdentifier(value, 'candidateId');
      break;
    case 'distill_candidate_decision':
      requireIdentifier(value, 'candidateId');
      requireEnum(value, 'decision', DISTILL_DECISIONS);
      break;
    case 'memory_promote_pending':
      if (value.dryRun !== undefined && typeof value.dryRun !== 'boolean') {
        throw new Error('dryRun must be a boolean');
      }
      break;
    case 'next_action_execute':
      requireIdentifier(value, 'actionId');
      if (value.outcome !== undefined) requireEnum(value, 'outcome', NEXT_ACTION_OUTCOMES);
      break;
    case 'close_browser_session':
    case 'restart_browser_session':
      requireIdentifier(value, 'sessionId');
      break;
    case 'promote_mission_seed':
      requireIdentifier(value, 'seedId');
      break;
    case 'create_track_seed':
      requireIdentifier(value, 'trackId');
      if (value.artifactId !== undefined && value.artifactId !== null) {
        requireIdentifier(value, 'artifactId');
      }
      break;
    case 'mission_control':
      requireIdentifier(value, 'missionId');
      requireEnum(value, 'operation', MISSION_OPERATIONS);
      break;
    case 'intervention_respond':
      requireIdentifier(value, 'missionId');
      requireString(value, 'response');
      break;
    case 'surface_control': {
      const operation = requireEnum(value, 'operation', SURFACE_OPERATIONS);
      const surfaceId = value.surfaceId;
      if (surfaceId !== undefined && surfaceId !== null) requireIdentifier(value, 'surfaceId');
      if (
        (operation === 'start' || operation === 'stop') &&
        (typeof surfaceId !== 'string' || !surfaceId.trim())
      ) {
        throw new Error('surfaceId is required for start and stop');
      }
      break;
    }
    case 'clear_surface_outbox':
      requireEnum(value, 'surface', SURFACES);
      requireIdentifier(value, 'messageId');
      break;
    case 'cleanup_runtime_lease':
    case 'restart_runtime_lease':
      requireIdentifier(value, 'agentId');
      break;
  }

  return { ...value, action };
}
