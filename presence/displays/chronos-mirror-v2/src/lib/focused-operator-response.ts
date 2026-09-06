import { isRecord } from '@agent/core/foundation/primitives';
import type { MissionAssetCategory } from './mission-progress-client';
import type { Payload } from '../components/FocusedOperatorViewModel';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ASSET_CATEGORIES = new Set(['deliverables', 'artifacts', 'outputs', 'evidence']);
const SECRET_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const CONTROL_TONES = new Set(['planning', 'ready', 'attention', 'pending']);
const SURFACE_TONES = new Set(['stable', 'attention', 'offline', 'pending']);
const SESSION_KINDS = new Set(['browser', 'terminal', 'system']);
const FLOW_KINDS = new Set(['a2a', 'agent_message', 'surface_link']);

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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || nonNegativeInteger(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
}

function parseAsset(
  value: unknown
): Payload['missionProgress'][number]['generatedAssets'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.path) ||
    typeof value.category !== 'string' ||
    !ASSET_CATEGORIES.has(value.category) ||
    !nonNegativeInteger(value.sizeBytes) ||
    !nonEmptyString(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    path: value.path,
    category: value.category as MissionAssetCategory,
    sizeBytes: value.sizeBytes,
    updatedAt: value.updatedAt,
  };
}

function parseMission(value: unknown): Payload['activeMissions'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.missionId) ||
    !nonEmptyString(value.tier) ||
    !optionalString(value.missionType) ||
    !nonNegativeInteger(value.nextTaskCount) ||
    !nonEmptyString(value.controlSummary) ||
    typeof value.controlTone !== 'string' ||
    !CONTROL_TONES.has(value.controlTone)
  ) {
    return undefined;
  }
  return {
    missionId: value.missionId,
    tier: value.tier,
    ...(value.missionType !== undefined ? { missionType: value.missionType } : {}),
    nextTaskCount: value.nextTaskCount,
    controlSummary: value.controlSummary,
    controlTone: value.controlTone as Payload['activeMissions'][number]['controlTone'],
  };
}

function parseMissionProgress(value: unknown): Payload['missionProgress'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.missionId) ||
    !nonEmptyString(value.boardStatus) ||
    !nonNegativeInteger(value.boardStepsTotal) ||
    !nonNegativeInteger(value.boardStepsDone) ||
    !nonNegativeInteger(value.boardStepsActive) ||
    !nonNegativeInteger(value.boardStepsPending) ||
    !nonNegativeInteger(value.nextTasksTotal) ||
    !nonNegativeInteger(value.nextTasksPending) ||
    !nonNegativeInteger(value.nextTasksCompleted) ||
    !stringArray(value.dependencies) ||
    !Array.isArray(value.generatedAssets)
  ) {
    return undefined;
  }
  const generatedAssets = value.generatedAssets.map(parseAsset);
  if (!generatedAssets.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return {
    missionId: value.missionId,
    boardStatus: value.boardStatus,
    boardStepsTotal: value.boardStepsTotal,
    boardStepsDone: value.boardStepsDone,
    boardStepsActive: value.boardStepsActive,
    boardStepsPending: value.boardStepsPending,
    nextTasksTotal: value.nextTasksTotal,
    nextTasksPending: value.nextTasksPending,
    nextTasksCompleted: value.nextTasksCompleted,
    dependencies: value.dependencies,
    generatedAssets,
  };
}

function parseSecretApproval(value: unknown): Payload['secretApprovals'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.summary) ||
    !nonEmptyString(value.storageChannel) ||
    !nonEmptyString(value.requestedAt) ||
    !nonEmptyString(value.requestedBy) ||
    !nonEmptyString(value.serviceId) ||
    !nonEmptyString(value.secretKey) ||
    !nonEmptyString(value.mutation) ||
    typeof value.riskLevel !== 'string' ||
    !SECRET_RISK_LEVELS.has(value.riskLevel) ||
    typeof value.requiresStrongAuth !== 'boolean' ||
    !stringArray(value.pendingRoles) ||
    (value.kind !== undefined &&
      value.kind !== 'secret_mutation' &&
      value.kind !== 'computer_action')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    summary: value.summary,
    storageChannel: value.storageChannel,
    requestedAt: value.requestedAt,
    requestedBy: value.requestedBy,
    serviceId: value.serviceId,
    secretKey: value.secretKey,
    mutation: value.mutation,
    riskLevel: value.riskLevel as Payload['secretApprovals'][number]['riskLevel'],
    requiresStrongAuth: value.requiresStrongAuth,
    pendingRoles: value.pendingRoles,
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
  };
}

function parseHandoff(value: unknown): Payload['a2aHandoffs'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.ts) ||
    !nonEmptyString(value.missionId) ||
    !nonEmptyString(value.sender) ||
    !nonEmptyString(value.receiver) ||
    !optionalString(value.teamRole) ||
    !optionalString(value.channel) ||
    !optionalString(value.thread) ||
    !optionalString(value.performative) ||
    !optionalString(value.intent) ||
    !optionalString(value.promptExcerpt)
  ) {
    return undefined;
  }
  return {
    ts: value.ts,
    missionId: value.missionId,
    sender: value.sender,
    receiver: value.receiver,
    ...(value.teamRole !== undefined ? { teamRole: value.teamRole } : {}),
    ...(value.channel !== undefined ? { channel: value.channel } : {}),
    ...(value.thread !== undefined ? { thread: value.thread } : {}),
    ...(value.performative !== undefined ? { performative: value.performative } : {}),
    ...(value.intent !== undefined ? { intent: value.intent } : {}),
    ...(value.promptExcerpt !== undefined ? { promptExcerpt: value.promptExcerpt } : {}),
  };
}

function parseDoctor(value: unknown): Payload['runtimeDoctor'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.severity !== 'string' ||
    !['warning', 'critical'].includes(value.severity) ||
    !nonEmptyString(value.agentId) ||
    !nonEmptyString(value.ownerId) ||
    !nonEmptyString(value.reason) ||
    !['stop_runtime', 'restart_runtime'].includes(value.recommendedAction as string)
  ) {
    return undefined;
  }
  return {
    severity: value.severity as 'warning' | 'critical',
    agentId: value.agentId,
    ownerId: value.ownerId,
    reason: value.reason,
    recommendedAction: value.recommendedAction as 'stop_runtime' | 'restart_runtime',
  };
}

function parseSurface(value: unknown): Payload['surfaces'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.health) ||
    !nonEmptyString(value.controlSummary) ||
    typeof value.controlTone !== 'string' ||
    !SURFACE_TONES.has(value.controlTone)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    health: value.health,
    controlSummary: value.controlSummary,
    controlTone: value.controlTone as Payload['surfaces'][number]['controlTone'],
  };
}

function parseOutbox(value: unknown): Payload['recentSurfaceOutbox'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.message_id) ||
    (value.surface !== 'slack' && value.surface !== 'chronos') ||
    !nonEmptyString(value.channel) ||
    !nonEmptyString(value.text) ||
    !nonEmptyString(value.created_at)
  ) {
    return undefined;
  }
  return {
    message_id: value.message_id,
    surface: value.surface,
    channel: value.channel,
    text: value.text,
    created_at: value.created_at,
  };
}

function parseComputerSession(value: unknown): Payload['computerSessions'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    typeof value.kind !== 'string' ||
    !SESSION_KINDS.has(value.kind) ||
    !nonEmptyString(value.status) ||
    !nonEmptyString(value.updatedAt) ||
    !optionalNonNegativeInteger(value.pid) ||
    !optionalString(value.target) ||
    !optionalString(value.detail) ||
    !optionalNonNegativeInteger(value.actionCount) ||
    !optionalRecord(value.metadata)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind as Payload['computerSessions'][number]['kind'],
    status: value.status,
    updatedAt: value.updatedAt,
    ...(value.pid !== undefined ? { pid: value.pid } : {}),
    ...(value.target !== undefined ? { target: value.target } : {}),
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
    ...(value.actionCount !== undefined ? { actionCount: value.actionCount } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
  };
}

function parseTopology(value: unknown): Payload['runtimeTopology'] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Array.isArray(value.surfaces) ||
    !Array.isArray(value.owners) ||
    !Array.isArray(value.runtimes) ||
    !Array.isArray(value.flows)
  )
    return undefined;
  const surfaces = value.surfaces.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.id) ||
      !nonEmptyString(entry.kind) ||
      typeof entry.running !== 'boolean' ||
      !optionalString(entry.startupMode) ||
      !optionalNonNegativeInteger(entry.pid)
    )
      return undefined;
    return {
      id: entry.id,
      kind: entry.kind,
      running: entry.running,
      ...(entry.startupMode !== undefined ? { startupMode: entry.startupMode } : {}),
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
    };
  });
  const owners = value.owners.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.id) ||
      !nonEmptyString(entry.type) ||
      !nonNegativeInteger(entry.runtimeCount) ||
      !stringArray(entry.runtimeIds)
    )
      return undefined;
    return {
      id: entry.id,
      type: entry.type,
      runtimeCount: entry.runtimeCount,
      runtimeIds: entry.runtimeIds,
    };
  });
  const runtimes = value.runtimes.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.agentId) ||
      !nonEmptyString(entry.provider) ||
      !optionalString(entry.modelId) ||
      !nonEmptyString(entry.status) ||
      !nonEmptyString(entry.ownerId) ||
      !nonEmptyString(entry.ownerType) ||
      !optionalString(entry.requestedBy) ||
      !optionalString(entry.leaseKind) ||
      !optionalNonNegativeInteger(entry.pid) ||
      !nonNegativeInteger(entry.recentActivityCount)
    )
      return undefined;
    return {
      agentId: entry.agentId,
      provider: entry.provider,
      ...(entry.modelId !== undefined ? { modelId: entry.modelId } : {}),
      status: entry.status,
      ownerId: entry.ownerId,
      ownerType: entry.ownerType,
      ...(entry.requestedBy !== undefined ? { requestedBy: entry.requestedBy } : {}),
      ...(entry.leaseKind !== undefined ? { leaseKind: entry.leaseKind } : {}),
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      recentActivityCount: entry.recentActivityCount,
    };
  });
  const flows = value.flows.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.id) ||
      !nonEmptyString(entry.from) ||
      !nonEmptyString(entry.to) ||
      !nonNegativeInteger(entry.count) ||
      !nonEmptyString(entry.latestAt) ||
      typeof entry.kind !== 'string' ||
      !FLOW_KINDS.has(entry.kind) ||
      !optionalString(entry.channel) ||
      !optionalString(entry.thread)
    )
      return undefined;
    return {
      id: entry.id,
      from: entry.from,
      to: entry.to,
      count: entry.count,
      latestAt: entry.latestAt,
      kind: entry.kind as Payload['runtimeTopology']['flows'][number]['kind'],
      ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
      ...(entry.thread !== undefined ? { thread: entry.thread } : {}),
    };
  });
  if (
    !surfaces.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !owners.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !runtimes.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !flows.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  )
    return undefined;
  return { surfaces, owners, runtimes, flows };
}

function parseOwnerSummary(value: unknown): Payload['ownerSummaries'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.ts) ||
    !nonEmptyString(value.mission_id) ||
    !nonNegativeInteger(value.accepted_count) ||
    !nonNegativeInteger(value.reviewed_count) ||
    !nonNegativeInteger(value.completed_count) ||
    !nonNegativeInteger(value.requested_count)
  )
    return undefined;
  return {
    ts: value.ts,
    mission_id: value.mission_id,
    accepted_count: value.accepted_count,
    reviewed_count: value.reviewed_count,
    completed_count: value.completed_count,
    requested_count: value.requested_count,
  };
}

function parseEvent(value: unknown): Payload['recentEvents'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.ts) ||
    !nonEmptyString(value.decision) ||
    !optionalString(value.mission_id) ||
    !optionalString(value.why)
  )
    return undefined;
  return {
    ts: value.ts,
    decision: value.decision,
    ...(value.mission_id !== undefined ? { mission_id: value.mission_id } : {}),
    ...(value.why !== undefined ? { why: value.why } : {}),
  };
}

export function parseFocusedOperatorResponse(value: unknown): Payload | undefined {
  if (!isRecord(value) || !hasSafeTree(value) || !nonNegativeInteger(value.revision))
    return undefined;
  if (
    !Array.isArray(value.activeMissions) ||
    !Array.isArray(value.missionProgress) ||
    !Array.isArray(value.secretApprovals) ||
    !Array.isArray(value.a2aHandoffs) ||
    !Array.isArray(value.runtimeDoctor) ||
    !Array.isArray(value.surfaces) ||
    !Array.isArray(value.recentSurfaceOutbox) ||
    !Array.isArray(value.computerSessions) ||
    !Array.isArray(value.ownerSummaries) ||
    !Array.isArray(value.recentEvents)
  )
    return undefined;
  const activeMissions = value.activeMissions.map(parseMission);
  const missionProgress = value.missionProgress.map(parseMissionProgress);
  const secretApprovals = value.secretApprovals.map(parseSecretApproval);
  const a2aHandoffs = value.a2aHandoffs.map(parseHandoff);
  const runtimeDoctor = value.runtimeDoctor.map(parseDoctor);
  const surfaces = value.surfaces.map(parseSurface);
  const recentSurfaceOutbox = value.recentSurfaceOutbox.map(parseOutbox);
  const computerSessions = value.computerSessions.map(parseComputerSession);
  const ownerSummaries = value.ownerSummaries.map(parseOwnerSummary);
  const recentEvents = value.recentEvents.map(parseEvent);
  const runtimeTopology = parseTopology(value.runtimeTopology);
  const runtime = value.runtime;
  if (
    !runtimeTopology ||
    !activeMissions.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !missionProgress.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !secretApprovals.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !a2aHandoffs.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !runtimeDoctor.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !surfaces.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !recentSurfaceOutbox.every(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined
    ) ||
    !computerSessions.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !ownerSummaries.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !recentEvents.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  )
    return undefined;
  if (
    runtime !== undefined &&
    (!isRecord(runtime) ||
      !nonNegativeInteger(runtime.total) ||
      !nonNegativeInteger(runtime.ready) ||
      !nonNegativeInteger(runtime.busy) ||
      !nonNegativeInteger(runtime.error))
  )
    return undefined;
  return {
    revision: value.revision,
    activeMissions,
    missionProgress,
    secretApprovals,
    a2aHandoffs,
    runtimeDoctor,
    surfaces,
    recentSurfaceOutbox,
    computerSessions,
    runtimeTopology,
    runtime: runtime
      ? { total: runtime.total, ready: runtime.ready, busy: runtime.busy, error: runtime.error }
      : undefined,
    ownerSummaries,
    recentEvents,
  };
}
