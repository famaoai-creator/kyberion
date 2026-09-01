import { isRecord } from './json-primitives';

type HeldAction = {
  id: string;
  op: string;
  missionId: string;
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled' | 'failed';
  submittedAt: string;
  submittedBy: string;
  tenantSlug?: string;
  irreversible?: boolean;
  effectBinding?: string;
  failureRecorded?: boolean;
};

type Observation = {
  id: string;
  service: string;
  resourceRef: string;
  tier: 'personal' | 'confidential' | 'public';
  purpose: string;
  summary: string;
  observedAt: string;
};

export type CloudflareOsSnapshot = {
  heldActions: HeldAction[];
  observations: Observation[];
};

export type CloudflareOsResponse =
  { ok: true; snapshot: CloudflareOsSnapshot } | { ok: false; error: string };

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value) ? value : undefined;
}

function parseHeldAction(value: unknown): HeldAction | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !requiredString(value.id) ||
    !requiredString(value.op) ||
    !requiredString(value.missionId) ||
    !requiredString(value.submittedAt) ||
    !requiredString(value.submittedBy) ||
    (value.status !== 'pending' &&
      value.status !== 'approved' &&
      value.status !== 'applied' &&
      value.status !== 'rejected' &&
      value.status !== 'cancelled' &&
      value.status !== 'failed')
  ) {
    return undefined;
  }
  const tenantSlug = optionalString(value.tenantSlug);
  const effectBinding = optionalString(value.effectBinding);
  if (
    (tenantSlug === undefined && value.tenantSlug !== undefined) ||
    (effectBinding === undefined && value.effectBinding !== undefined) ||
    (value.irreversible !== undefined && typeof value.irreversible !== 'boolean') ||
    (value.failureRecorded !== undefined && typeof value.failureRecorded !== 'boolean')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    op: value.op,
    missionId: value.missionId,
    status: value.status,
    submittedAt: value.submittedAt,
    submittedBy: value.submittedBy,
    ...(tenantSlug ? { tenantSlug } : {}),
    ...(value.irreversible !== undefined ? { irreversible: value.irreversible } : {}),
    ...(effectBinding ? { effectBinding } : {}),
    ...(value.failureRecorded !== undefined ? { failureRecorded: value.failureRecorded } : {}),
  };
}

function parseObservation(value: unknown): Observation | undefined {
  if (
    !isRecord(value) ||
    !requiredString(value.id) ||
    !requiredString(value.service) ||
    !requiredString(value.resourceRef) ||
    !requiredString(value.purpose) ||
    !requiredString(value.summary) ||
    !requiredString(value.observedAt) ||
    (value.tier !== 'personal' && value.tier !== 'confidential' && value.tier !== 'public')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    service: value.service,
    resourceRef: value.resourceRef,
    tier: value.tier,
    purpose: value.purpose,
    summary: value.summary,
    observedAt: value.observedAt,
  };
}

export function parseCloudflareOsResponse(value: unknown): CloudflareOsResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return { ok: false, error: 'Invalid OS control-plane response' };
  }
  if (!value.ok) {
    return {
      ok: false,
      error:
        typeof value.error === 'string' && value.error.trim()
          ? value.error
          : 'OS control-plane request failed',
    };
  }
  if (!Array.isArray(value.heldActions) || !Array.isArray(value.observations)) {
    return { ok: false, error: 'Invalid OS control-plane snapshot' };
  }
  const heldActions = value.heldActions.map(parseHeldAction);
  const observations = value.observations.map(parseObservation);
  if (
    heldActions.some((item): item is undefined => item === undefined) ||
    observations.some((item): item is undefined => item === undefined)
  ) {
    return { ok: false, error: 'Invalid OS control-plane snapshot item' };
  }
  return {
    ok: true,
    snapshot: {
      heldActions: heldActions as HeldAction[],
      observations: observations as Observation[],
    },
  };
}
