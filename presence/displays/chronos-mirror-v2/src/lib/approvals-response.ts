import { isRecord } from '@agent/core/foundation/primitives';

export type ClientApproval = {
  id: string;
  channel: string;
  storageChannel: string;
  title: string;
  summary: string;
  details?: string;
  sourceText?: string;
  target?: {
    serviceId: string;
    secretKey: string;
    mutation: string;
    existingValuePresent?: boolean;
  };
  justification?: {
    reason: string;
    impactSummary?: string;
    evidence?: string[];
    requestedEffects?: string[];
  };
  risk?: {
    level: string;
    restartScope: string;
    requiresStrongAuth: boolean;
    policyId?: string;
  };
  workLoop?: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    context?: Record<string, unknown>;
  };
  requestedAt: string;
  requestedBy: string;
  missionId?: string;
  tenantSlug?: string;
  status: string;
  kind?: string;
};

export type ClientApprovalsResponse = {
  approvals: ClientApproval[];
  accessRole: 'readonly' | 'localadmin';
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACCESS_ROLES = new Set(['readonly', 'localadmin']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function parseTarget(value: unknown): ClientApproval['target'] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.serviceId) ||
    !nonEmptyString(value.secretKey) ||
    !nonEmptyString(value.mutation) ||
    (value.existingValuePresent !== undefined && typeof value.existingValuePresent !== 'boolean')
  ) {
    return undefined;
  }
  return {
    serviceId: value.serviceId,
    secretKey: value.secretKey,
    mutation: value.mutation,
    ...(value.existingValuePresent !== undefined
      ? { existingValuePresent: value.existingValuePresent }
      : {}),
  };
}

function parseJustification(value: unknown): ClientApproval['justification'] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.reason) ||
    !optionalString(value.impactSummary) ||
    !optionalStringArray(value.evidence) ||
    !optionalStringArray(value.requestedEffects)
  ) {
    return undefined;
  }
  return {
    reason: value.reason,
    ...(value.impactSummary !== undefined ? { impactSummary: value.impactSummary } : {}),
    ...(value.evidence !== undefined ? { evidence: value.evidence } : {}),
    ...(value.requestedEffects !== undefined ? { requestedEffects: value.requestedEffects } : {}),
  };
}

function parseRisk(value: unknown): ClientApproval['risk'] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.level) ||
    !nonEmptyString(value.restartScope) ||
    typeof value.requiresStrongAuth !== 'boolean' ||
    !optionalString(value.policyId)
  ) {
    return undefined;
  }
  return {
    level: value.level,
    restartScope: value.restartScope,
    requiresStrongAuth: value.requiresStrongAuth,
    ...(value.policyId !== undefined ? { policyId: value.policyId } : {}),
  };
}

function parseWorkLoop(value: unknown): ClientApproval['workLoop'] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !optionalString(value.project_id) ||
    !optionalString(value.project_name) ||
    !optionalString(value.track_id) ||
    !optionalString(value.track_name) ||
    (value.context !== undefined && (!isRecord(value.context) || !hasSafeTree(value.context)))
  ) {
    return undefined;
  }
  return {
    ...(value.project_id !== undefined ? { project_id: value.project_id } : {}),
    ...(value.project_name !== undefined ? { project_name: value.project_name } : {}),
    ...(value.track_id !== undefined ? { track_id: value.track_id } : {}),
    ...(value.track_name !== undefined ? { track_name: value.track_name } : {}),
    ...(value.context !== undefined ? { context: value.context } : {}),
  };
}

function parseApproval(value: unknown): ClientApproval | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.storageChannel) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.summary) ||
    !optionalString(value.details) ||
    !optionalString(value.sourceText) ||
    !nonEmptyString(value.requestedAt) ||
    !nonEmptyString(value.requestedBy) ||
    !optionalString(value.missionId) ||
    !optionalString(value.tenantSlug) ||
    !nonEmptyString(value.status) ||
    !optionalString(value.kind)
  ) {
    return undefined;
  }
  const target = value.target === undefined ? undefined : parseTarget(value.target);
  const justification =
    value.justification === undefined ? undefined : parseJustification(value.justification);
  const risk = value.risk === undefined ? undefined : parseRisk(value.risk);
  const workLoop = value.workLoop === undefined ? undefined : parseWorkLoop(value.workLoop);
  if (
    (value.target !== undefined && !target) ||
    (value.justification !== undefined && !justification) ||
    (value.risk !== undefined && !risk) ||
    (value.workLoop !== undefined && !workLoop)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    channel: value.channel,
    storageChannel: value.storageChannel,
    title: value.title,
    summary: value.summary,
    ...(value.details !== undefined ? { details: value.details } : {}),
    ...(value.sourceText !== undefined ? { sourceText: value.sourceText } : {}),
    ...(target ? { target } : {}),
    ...(justification ? { justification } : {}),
    ...(risk ? { risk } : {}),
    ...(workLoop ? { workLoop } : {}),
    requestedAt: value.requestedAt,
    requestedBy: value.requestedBy,
    ...(value.missionId !== undefined ? { missionId: value.missionId } : {}),
    ...(value.tenantSlug !== undefined ? { tenantSlug: value.tenantSlug } : {}),
    status: value.status,
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
  };
}

export function parseApprovalsResponse(value: unknown): ClientApprovalsResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    !Array.isArray(value.approvals) ||
    typeof value.accessRole !== 'string' ||
    !ACCESS_ROLES.has(value.accessRole)
  ) {
    return undefined;
  }
  const approvals = value.approvals.map(parseApproval);
  if (!approvals.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return {
    approvals,
    accessRole: value.accessRole as ClientApprovalsResponse['accessRole'],
  };
}
