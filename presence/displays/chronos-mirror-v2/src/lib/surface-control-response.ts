import { isRecord } from '@agent/core/foundation/primitives';

export type ClientSurfaceControlAction = {
  operation: string;
  label: string;
  risk: 'safe' | 'risky';
  enabled: boolean;
  disabledReason?: string;
};

export type ClientSurfaceSummary = {
  id: string;
  kind: string;
  startupMode?: string;
  running: boolean;
  health: string;
  detail?: string;
  controlSummary?: string;
  controlRequestedBy?: string;
};

export type ClientSurfaceControlActionSummary = {
  event_id?: string;
  ts?: string;
  kind: 'mission' | 'surface';
  target: string;
  operation: string;
  status: 'queued' | 'completed' | 'failed';
  requested_by?: string;
  error?: string;
};

export type SurfaceControlResponse = {
  surfaces: ClientSurfaceSummary[];
  controlActions: ClientSurfaceControlActionSummary[];
  controlActionAvailability: {
    globalSurface: ClientSurfaceControlAction[];
    surface: Record<string, ClientSurfaceControlAction[]>;
  };
};

export type SurfaceControlActionResponse = {
  status: 'queued';
  action: 'surface_control';
  surfaceId: string;
  operation: string;
  eventId: string;
  ts: string;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACTION_RISKS = new Set(['safe', 'risky']);
const ACTION_KINDS = new Set(['mission', 'surface']);
const ACTION_STATUSES = new Set(['queued', 'completed', 'failed']);
const SURFACE_OPERATIONS = new Set(['reconcile', 'status', 'start', 'stop']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || string(value);
}

function parseAction(value: unknown): ClientSurfaceControlAction | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.operation) ||
    !nonEmptyString(value.label) ||
    typeof value.risk !== 'string' ||
    !ACTION_RISKS.has(value.risk) ||
    typeof value.enabled !== 'boolean' ||
    !optionalString(value.disabledReason)
  ) {
    return undefined;
  }
  return {
    operation: value.operation,
    label: value.label,
    risk: value.risk,
    enabled: value.enabled,
    ...(value.disabledReason !== undefined ? { disabledReason: value.disabledReason } : {}),
  };
}

function parseSurface(value: unknown): ClientSurfaceSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.kind) ||
    !optionalString(value.startupMode) ||
    typeof value.running !== 'boolean' ||
    !nonEmptyString(value.health) ||
    !optionalString(value.detail) ||
    !optionalString(value.controlSummary) ||
    !optionalString(value.controlRequestedBy)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind,
    ...(value.startupMode !== undefined ? { startupMode: value.startupMode } : {}),
    running: value.running,
    health: value.health,
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
    ...(value.controlSummary !== undefined ? { controlSummary: value.controlSummary } : {}),
    ...(value.controlRequestedBy !== undefined
      ? { controlRequestedBy: value.controlRequestedBy }
      : {}),
  };
}

function parseActionSummary(value: unknown): ClientSurfaceControlActionSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !optionalString(value.event_id) ||
    !optionalString(value.ts) ||
    typeof value.kind !== 'string' ||
    !ACTION_KINDS.has(value.kind) ||
    !nonEmptyString(value.target) ||
    !nonEmptyString(value.operation) ||
    typeof value.status !== 'string' ||
    !ACTION_STATUSES.has(value.status) ||
    !optionalString(value.requested_by) ||
    !optionalString(value.error)
  ) {
    return undefined;
  }
  return {
    ...(value.event_id !== undefined ? { event_id: value.event_id } : {}),
    ...(value.ts !== undefined ? { ts: value.ts } : {}),
    kind: value.kind,
    target: value.target,
    operation: value.operation,
    status: value.status,
    ...(value.requested_by !== undefined ? { requested_by: value.requested_by } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

function parseActionArray(value: unknown): ClientSurfaceControlAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.map(parseAction);
  return actions.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    ? actions
    : undefined;
}

export function parseSurfaceControlResponse(value: unknown): SurfaceControlResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    !Array.isArray(value.surfaces) ||
    !Array.isArray(value.controlActions) ||
    !isRecord(value.controlActionAvailability)
  ) {
    return undefined;
  }
  const surfaces = value.surfaces.map(parseSurface);
  const controlActions = value.controlActions.map(parseActionSummary);
  const globalSurface = parseActionArray(value.controlActionAvailability.globalSurface);
  const surface = value.controlActionAvailability.surface;
  if (
    !surfaces.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !controlActions.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !globalSurface ||
    !isRecord(surface) ||
    !hasSafeTree(surface)
  ) {
    return undefined;
  }
  const parsedSurface = Object.entries(surface).map(([id, actions]) => {
    const parsed = parseActionArray(actions);
    return parsed ? ([id, parsed] as const) : undefined;
  });
  if (parsedSurface.some((entry) => !entry)) return undefined;
  return {
    surfaces,
    controlActions,
    controlActionAvailability: {
      globalSurface,
      surface: Object.fromEntries(
        parsedSurface as Array<readonly [string, ClientSurfaceControlAction[]]>
      ),
    },
  };
}

export function parseSurfaceControlActionResponse(
  value: unknown
): SurfaceControlActionResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'queued' ||
    value.action !== 'surface_control' ||
    !string(value.surfaceId) ||
    !nonEmptyString(value.operation) ||
    !SURFACE_OPERATIONS.has(value.operation) ||
    !nonEmptyString(value.eventId) ||
    !nonEmptyString(value.ts)
  ) {
    return undefined;
  }
  return {
    status: 'queued',
    action: 'surface_control',
    surfaceId: value.surfaceId,
    operation: value.operation,
    eventId: value.eventId,
    ts: value.ts,
  };
}
