import { chronosSpeechLocale } from '../lib/ux-vocabulary';
import { optionalStringField, parseJsonRecord } from '../lib/json-record';
import type { MissionAssetCategory } from '../lib/mission-progress';
import type { AttentionItem } from '../lib/operator-console';

export type FocusedViewId =
  | 'needs-attention'
  | 'mission-control-plane'
  | 'computer-sessions'
  | 'runtime-topology-map'
  | 'runtime-lease-doctor'
  | 'recent-surface-outbox'
  | 'secret-approval-queue'
  | 'owner-summaries'
  | 'trace-viewer';

export interface Payload {
  revision: number;
  activeMissions: Array<{
    missionId: string;
    tier: string;
    missionType?: string;
    nextTaskCount: number;
    controlSummary: string;
    controlTone: 'planning' | 'ready' | 'attention' | 'pending';
  }>;
  missionProgress: Array<{
    missionId: string;
    boardStatus: string;
    boardStepsTotal: number;
    boardStepsDone: number;
    boardStepsActive: number;
    boardStepsPending: number;
    nextTasksTotal: number;
    nextTasksPending: number;
    nextTasksCompleted: number;
    dependencies: string[];
    generatedAssets: Array<{
      path: string;
      category: MissionAssetCategory;
      sizeBytes: number;
      updatedAt: string;
    }>;
  }>;
  secretApprovals: Array<{
    id: string;
    title: string;
    summary: string;
    storageChannel: string;
    requestedAt: string;
    requestedBy: string;
    serviceId: string;
    secretKey: string;
    mutation: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    requiresStrongAuth: boolean;
    pendingRoles: string[];
    kind?: 'secret_mutation' | 'computer_action';
  }>;
  a2aHandoffs: Array<{
    ts: string;
    missionId: string;
    sender: string;
    receiver: string;
    teamRole?: string;
    channel?: string;
    thread?: string;
    performative?: string;
    intent?: string;
    promptExcerpt?: string;
  }>;
  runtimeDoctor: Array<{
    severity: 'warning' | 'critical';
    agentId: string;
    ownerId: string;
    reason: string;
    recommendedAction: 'stop_runtime' | 'restart_runtime';
  }>;
  surfaces: Array<{
    id: string;
    health: string;
    controlSummary: string;
    controlTone: 'stable' | 'attention' | 'offline' | 'pending';
  }>;
  recentSurfaceOutbox: Array<{
    message_id: string;
    surface: 'slack' | 'chronos';
    channel: string;
    text: string;
    created_at: string;
  }>;
  computerSessions: Array<{
    id: string;
    kind: 'browser' | 'terminal' | 'system';
    status: string;
    updatedAt: string;
    pid?: number;
    target?: string;
    detail?: string;
    actionCount?: number;
    metadata?: Record<string, unknown>;
  }>;
  runtimeTopology: {
    surfaces: Array<{
      id: string;
      kind: string;
      running: boolean;
      startupMode?: string;
      pid?: number;
    }>;
    owners: Array<{ id: string; type: string; runtimeCount: number; runtimeIds: string[] }>;
    runtimes: Array<{
      agentId: string;
      provider: string;
      modelId?: string;
      status: string;
      ownerId: string;
      ownerType: string;
      requestedBy?: string;
      leaseKind?: string;
      pid?: number;
      recentActivityCount: number;
    }>;
    flows: Array<{
      id: string;
      from: string;
      to: string;
      count: number;
      latestAt: string;
      kind: 'a2a' | 'agent_message' | 'surface_link';
      channel?: string;
      thread?: string;
    }>;
  };
  runtime?: {
    total: number;
    ready: number;
    busy: number;
    error: number;
  };
  ownerSummaries: Array<{
    ts: string;
    mission_id: string;
    accepted_count: number;
    reviewed_count: number;
    completed_count: number;
    requested_count: number;
  }>;
  recentEvents: Array<{
    ts: string;
    decision: string;
    mission_id?: string;
    why?: string;
  }>;
}

const EMPTY_PAYLOAD: Payload = {
  revision: 0,
  activeMissions: [],
  missionProgress: [],
  secretApprovals: [],
  a2aHandoffs: [],
  runtimeDoctor: [],
  surfaces: [],
  recentSurfaceOutbox: [],
  computerSessions: [],
  runtimeTopology: {
    surfaces: [],
    owners: [],
    runtimes: [],
    flows: [],
  },
  runtime: {
    total: 0,
    ready: 0,
    busy: 0,
    error: 0,
  },
  ownerSummaries: [],
  recentEvents: [],
};

export function normalizePayload(input: Partial<Payload> | null | undefined): Payload {
  return {
    ...EMPTY_PAYLOAD,
    ...input,
    revision: typeof input?.revision === 'number' ? input.revision : EMPTY_PAYLOAD.revision,
    activeMissions: Array.isArray(input?.activeMissions)
      ? input.activeMissions
      : EMPTY_PAYLOAD.activeMissions,
    missionProgress: Array.isArray(input?.missionProgress)
      ? input.missionProgress
      : EMPTY_PAYLOAD.missionProgress,
    secretApprovals: Array.isArray(input?.secretApprovals)
      ? input.secretApprovals
      : EMPTY_PAYLOAD.secretApprovals,
    a2aHandoffs: Array.isArray(input?.a2aHandoffs) ? input.a2aHandoffs : EMPTY_PAYLOAD.a2aHandoffs,
    runtimeDoctor: Array.isArray(input?.runtimeDoctor)
      ? input.runtimeDoctor
      : EMPTY_PAYLOAD.runtimeDoctor,
    surfaces: Array.isArray(input?.surfaces) ? input.surfaces : EMPTY_PAYLOAD.surfaces,
    recentSurfaceOutbox: Array.isArray(input?.recentSurfaceOutbox)
      ? input.recentSurfaceOutbox
      : EMPTY_PAYLOAD.recentSurfaceOutbox,
    computerSessions: Array.isArray(input?.computerSessions)
      ? input.computerSessions
      : EMPTY_PAYLOAD.computerSessions,
    runtimeTopology: {
      ...EMPTY_PAYLOAD.runtimeTopology,
      ...(input?.runtimeTopology || {}),
      surfaces: Array.isArray(input?.runtimeTopology?.surfaces)
        ? input.runtimeTopology.surfaces
        : EMPTY_PAYLOAD.runtimeTopology.surfaces,
      owners: Array.isArray(input?.runtimeTopology?.owners)
        ? input.runtimeTopology.owners
        : EMPTY_PAYLOAD.runtimeTopology.owners,
      runtimes: Array.isArray(input?.runtimeTopology?.runtimes)
        ? input.runtimeTopology.runtimes
        : EMPTY_PAYLOAD.runtimeTopology.runtimes,
      flows: Array.isArray(input?.runtimeTopology?.flows)
        ? input.runtimeTopology.flows
        : EMPTY_PAYLOAD.runtimeTopology.flows,
    },
    runtime: input?.runtime
      ? { ...EMPTY_PAYLOAD.runtime, ...input.runtime }
      : EMPTY_PAYLOAD.runtime,
    ownerSummaries: Array.isArray(input?.ownerSummaries)
      ? input.ownerSummaries
      : EMPTY_PAYLOAD.ownerSummaries,
    recentEvents: Array.isArray(input?.recentEvents)
      ? input.recentEvents
      : EMPTY_PAYLOAD.recentEvents,
  };
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString(chronosSpeechLocale());
  } catch {
    return value;
  }
}

export function graphNodePalette(kind: 'surface' | 'runtime' | 'peer'): {
  fill: string;
  stroke: string;
} {
  if (kind === 'surface') return { fill: '#31214d', stroke: '#c39cff' };
  if (kind === 'runtime') return { fill: '#183425', stroke: '#88f0b2' };
  return { fill: '#362818', stroke: '#f0c78a' };
}

export const RUNTIME_GRAPH_NODE_WIDTH = 156;
export const RUNTIME_GRAPH_NODE_HEIGHT = 40;
const FOCUSED_OPERATOR_PREFS_KEY = 'chronos.focused-operator.prefs';

export function attentionItemTargetViewId(item: AttentionItem): FocusedViewId | null {
  if (item.targetType === 'mission') return 'mission-control-plane';
  if (item.targetType === 'runtime') return 'runtime-lease-doctor';
  if (item.targetType === 'surface') return 'runtime-topology-map';
  if (item.targetType === 'delivery') return 'recent-surface-outbox';
  if (item.targetType === 'approval') return 'secret-approval-queue';
  return null;
}

export function attentionItemTargetMissionId(item: AttentionItem): string | null {
  return item.targetType === 'mission' ? item.targetId : null;
}

export function attentionItemTargetViewLabel(item: AttentionItem): string | null {
  const viewId = attentionItemTargetViewId(item);
  if (viewId === 'mission-control-plane') return 'Mission Control';
  if (viewId === 'runtime-lease-doctor') return 'Runtime Governance';
  if (viewId === 'runtime-topology-map') return 'Runtime Topology';
  if (viewId === 'recent-surface-outbox') return 'Delivery Exceptions';
  if (viewId === 'secret-approval-queue') return 'Secret Approvals';
  return null;
}

export function loadFocusedOperatorSelectedSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FOCUSED_OPERATOR_PREFS_KEY);
    if (!raw) return null;
    const parsed = parseJsonRecord(raw);
    return parsed ? optionalStringField(parsed, 'selectedSessionId') || null : null;
  } catch {
    return null;
  }
}

export function saveFocusedOperatorSelectedSessionId(selectedSessionId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FOCUSED_OPERATOR_PREFS_KEY, JSON.stringify({ selectedSessionId }));
  } catch {
    // localStorage may be denied; ignore.
  }
}

export function pickDefaultSessionId(
  sessions: ReadonlyArray<Payload['computerSessions'][number]>,
  selectedSessionId: string | null
): string | null {
  if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) {
    return selectedSessionId;
  }
  const prioritized =
    sessions.find((session) => session.kind === 'browser' && session.status === 'active') ||
    sessions.find((session) => session.kind === 'terminal' && session.status === 'active') ||
    sessions.find((session) => session.status === 'active') ||
    sessions.slice().sort((left, right) => {
      const leftTime = new Date(left.updatedAt).getTime();
      const rightTime = new Date(right.updatedAt).getTime();
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
      if (Number.isNaN(leftTime)) return 1;
      if (Number.isNaN(rightTime)) return -1;
      return rightTime - leftTime;
    })[0] ||
    sessions[0] ||
    null;
  return prioritized?.id || null;
}

export function resolveComputerSessionHotkeySelection(
  sessions: ReadonlyArray<Payload['computerSessions'][number]>,
  currentSessionId: string | null,
  key: string
): string | null {
  const normalized = key.toLowerCase();
  const index = Number.parseInt(normalized, 10);
  if (Number.isInteger(index) && index >= 1 && index <= 9) {
    return sessions[index - 1]?.id || null;
  }

  if (normalized !== 'j' && normalized !== 'k') return null;
  if (sessions.length === 0) return null;

  const currentIndex = currentSessionId
    ? sessions.findIndex((session) => session.id === currentSessionId)
    : -1;
  if (normalized === 'j') {
    return (
      sessions[Math.min(sessions.length - 1, currentIndex + 1 >= 0 ? currentIndex + 1 : 0)]?.id ||
      sessions[0]?.id ||
      null
    );
  }
  if (currentIndex <= 0) {
    return sessions[0]?.id || null;
  }
  return sessions[currentIndex - 1]?.id || sessions[0]?.id || null;
}

export function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
    (element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.tagName === 'SELECT' ||
      element.isContentEditable)
  );
}
