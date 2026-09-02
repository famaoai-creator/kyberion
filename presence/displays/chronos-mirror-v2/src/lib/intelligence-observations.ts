import { pathResolver } from '@agent/core/path-resolver';
import { validateBrowserConversationSession } from '@agent/core/browser-conversation-session';
import path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import {
  numberField,
  optionalStringField,
  parseJsonRecord,
  recordField,
  stringField,
} from './json-record';

export interface OrchestrationEventSummary {
  ts: string;
  decision: string;
  mission_id?: string;
  why?: string;
}

export interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: 'mission' | 'surface';
  target: string;
  operation: string;
  status: 'queued' | 'completed' | 'failed';
  requested_by: string;
  error?: string;
}

export interface ControlActionDetail {
  ts: string;
  decision: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  operation?: string;
  why?: string;
  error?: string;
}

export interface OwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

export interface BrowserSessionSummary {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  last_trace_path?: string;
  lease_expires_at?: string;
  lease_status: 'active' | 'released' | 'expired';
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: 'control' | 'capture' | 'apply';
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

export interface BrowserConversationSessionSummary {
  session_id: string;
  surface: string;
  status: string;
  mode: string;
  updated_at: string;
  goal_summary: string;
  active_step?: string;
  pending_confirmation: boolean;
  candidate_target_count: number;
}

export interface BrowserObservationCollectionOptions {
  browserSessionsDir?: string;
  browserConversationSessionsDir?: string;
}

export interface IntelligenceObservationCollectionOptions {
  observationFiles?: readonly string[];
}

const BROWSER_SESSION_LEASE_STATUSES = new Set(['active', 'released', 'expired']);
const BROWSER_ACTION_KINDS = new Set(['control', 'capture', 'apply']);
const BROWSER_SESSION_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeObservationRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => !BROWSER_SESSION_DANGEROUS_KEYS.has(key));
}

function requiredObservationString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalObservationString(
  record: Record<string, unknown>,
  key: string
): string | undefined | null {
  if (!(key in record)) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function nonNegativeObservationCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseBrowserRecentAction(
  value: unknown
): BrowserSessionSummary['recent_actions'][number] | null {
  if (!isSafeObservationRecord(value)) return null;
  const op = requiredObservationString(value, 'op');
  const kind = requiredObservationString(value, 'kind');
  const ts = requiredObservationString(value, 'ts');
  if (!op || !ts || !kind || !BROWSER_ACTION_KINDS.has(kind)) return null;
  const tabId = optionalObservationString(value, 'tab_id');
  const ref = optionalObservationString(value, 'ref');
  const selector = optionalObservationString(value, 'selector');
  if (tabId === null || ref === null || selector === null) return null;
  return {
    op,
    kind: kind as BrowserSessionSummary['recent_actions'][number]['kind'],
    ...(tabId === undefined ? {} : { tab_id: tabId }),
    ...(ref === undefined ? {} : { ref }),
    ...(selector === undefined ? {} : { selector }),
    ts,
  };
}

export function parseBrowserSessionSummary(value: unknown): BrowserSessionSummary | null {
  if (!isSafeObservationRecord(value)) return null;
  const sessionId = requiredObservationString(value, 'session_id');
  const activeTabId = requiredObservationString(value, 'active_tab_id');
  const updatedAt = requiredObservationString(value, 'updated_at');
  const leaseStatus = requiredObservationString(value, 'lease_status');
  const tabCount = nonNegativeObservationCount(value, 'tab_count');
  const actionTrailCount = nonNegativeObservationCount(value, 'action_trail_count');
  const retained = value.retained;
  const recentActions = value.recent_actions;
  if (
    !sessionId ||
    !activeTabId ||
    !updatedAt ||
    !leaseStatus ||
    !BROWSER_SESSION_LEASE_STATUSES.has(leaseStatus) ||
    tabCount === null ||
    actionTrailCount === null ||
    typeof retained !== 'boolean' ||
    !Array.isArray(recentActions)
  ) {
    return null;
  }
  const parsedActions = recentActions.map(parseBrowserRecentAction);
  if (parsedActions.some((action) => action === null)) return null;

  const lastTracePath = optionalObservationString(value, 'last_trace_path');
  const leaseExpiresAt = optionalObservationString(value, 'lease_expires_at');
  if (lastTracePath === null || leaseExpiresAt === null) return null;
  return {
    session_id: sessionId,
    active_tab_id: activeTabId,
    tab_count: tabCount,
    updated_at: updatedAt,
    lease_status: leaseStatus as BrowserSessionSummary['lease_status'],
    retained,
    action_trail_count: actionTrailCount,
    recent_actions: parsedActions as BrowserSessionSummary['recent_actions'],
    ...(lastTracePath === undefined ? {} : { last_trace_path: lastTracePath }),
    ...(leaseExpiresAt === undefined ? {} : { lease_expires_at: leaseExpiresAt }),
  };
}

function parseBrowserConversationSessionSummary(
  value: unknown
): BrowserConversationSessionSummary | null {
  const validation = validateBrowserConversationSession(value);
  if (!validation.valid || !validation.value) return null;
  const session = validation.value;
  return {
    session_id: session.session_id,
    surface: session.surface,
    status: session.status,
    mode: session.mode,
    updated_at: session.updated_at,
    goal_summary: session.goal.summary,
    active_step: session.active_step?.description,
    pending_confirmation: session.conversation_context.pending_confirmation,
    candidate_target_count: session.candidate_targets.length,
  };
}

function safeObservationDirectory(directory: string): string | null {
  try {
    const safeDirectory = assertSafeRepositoryPath(directory, { allowMissingLeaf: true });
    return safeExistsSync(safeDirectory) && safeLstat(safeDirectory).isDirectory()
      ? safeDirectory
      : null;
  } catch {
    return null;
  }
}

function safeObservationFile(directory: string, entry: string): string | null {
  return safeObservationPath(path.join(directory, entry));
}

function safeObservationPath(filePath: string): string | null {
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, {
      allowMissingLeaf: true,
    });
    return safeExistsSync(safeFilePath) && safeLstat(safeFilePath).isFile() ? safeFilePath : null;
  } catch {
    return null;
  }
}

export function collectRecentEvents(
  options: IntelligenceObservationCollectionOptions = {}
): OrchestrationEventSummary[] {
  const files = options.observationFiles || [
    pathResolver.shared('observability/channels/slack/missions.jsonl'),
    pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
  ];
  const lines: OrchestrationEventSummary[] = [];
  for (const file of files) {
    const safeFile = safeObservationPath(file);
    if (!safeFile) continue;
    const raw = safeReadFile(safeFile, { encoding: 'utf8' }) as string;
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = parseJsonRecord(line);
        if (!event) continue;
        lines.push({
          ts: stringField(event, 'ts', new Date().toISOString()),
          decision: stringField(event, 'decision', stringField(event, 'event_type', 'event')),
          mission_id:
            optionalStringField(event, 'mission_id') || optionalStringField(event, 'resource_id'),
          why: optionalStringField(event, 'why'),
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return lines.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
}

export function collectControlActions(
  options: IntelligenceObservationCollectionOptions = {}
): ControlActionSummary[] {
  const file = safeObservationPath(
    options.observationFiles?.[0] ||
      pathResolver.shared('observability/mission-control/orchestration-events.jsonl')
  );
  if (!file) return [];

  const lifecycle = new Map<string, ControlActionSummary>();
  const raw = safeReadFile(file, { encoding: 'utf8' }) as string;

  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = parseJsonRecord(line);
      if (!event) continue;
      const payload = recordField(event.payload);
      const decision = stringField(event, 'decision', stringField(event, 'event_type'));
      const eventId = optionalStringField(event, 'event_id');

      if (
        decision === 'mission_orchestration_event_enqueued' &&
        (event.event_type === 'mission_control_requested' ||
          event.event_type === 'surface_control_requested') &&
        eventId
      ) {
        const eventType = stringField(event, 'event_type');
        const queuedTarget =
          eventType === 'surface_control_requested'
            ? stringField(payload, 'surfaceId', 'surface-runtime')
            : stringField(event, 'mission_id', 'system');
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: stringField(event, 'ts', new Date().toISOString()),
          kind: eventType === 'mission_control_requested' ? 'mission' : 'surface',
          target: queuedTarget,
          operation: stringField(payload, 'operation', eventType),
          status: 'queued',
          requested_by: stringField(event, 'requested_by', 'unknown'),
        });
        continue;
      }

      if (
        (decision === 'mission_control_action_applied' ||
          decision === 'surface_control_action_applied') &&
        typeof event.operation === 'string'
      ) {
        const syntheticId = `${decision}:${stringField(event, 'mission_id', stringField(event, 'resource_id', 'system'))}:${stringField(event, 'operation')}:${stringField(event, 'ts')}`;
        lifecycle.set(syntheticId, {
          event_id: eventId,
          ts: stringField(event, 'ts', new Date().toISOString()),
          kind: decision === 'mission_control_action_applied' ? 'mission' : 'surface',
          target: stringField(event, 'mission_id', stringField(event, 'resource_id', 'system')),
          operation: stringField(event, 'operation'),
          status: 'completed',
          requested_by: stringField(event, 'requested_by', 'unknown'),
        });
        continue;
      }

      if (
        decision === 'mission_orchestration_event_failed' &&
        (event.event_type === 'mission_control_requested' ||
          event.event_type === 'surface_control_requested') &&
        eventId
      ) {
        const eventType = stringField(event, 'event_type');
        const failedTarget =
          eventType === 'surface_control_requested'
            ? stringField(payload, 'surfaceId', 'surface-runtime')
            : stringField(event, 'mission_id', 'system');
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: stringField(event, 'ts', new Date().toISOString()),
          kind: eventType === 'mission_control_requested' ? 'mission' : 'surface',
          target: failedTarget,
          operation: stringField(payload, 'operation', eventType),
          status: 'failed',
          requested_by: stringField(event, 'requested_by', 'unknown'),
          error: optionalStringField(event, 'error'),
        });
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return Array.from(lifecycle.values())
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10);
}

export function collectControlActionDetails(
  options: IntelligenceObservationCollectionOptions = {}
): Record<string, ControlActionDetail[]> {
  const file = safeObservationPath(
    options.observationFiles?.[0] ||
      pathResolver.shared('observability/mission-control/orchestration-events.jsonl')
  );
  if (!file) return {};

  const details: Record<string, ControlActionDetail[]> = {};
  const raw = safeReadFile(file, { encoding: 'utf8' }) as string;

  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = parseJsonRecord(line);
      if (!event) continue;
      const eventId = optionalStringField(event, 'event_id');
      if (!eventId) continue;
      if (
        stringField(event, 'event_type') !== 'mission_control_requested' &&
        stringField(event, 'event_type') !== 'surface_control_requested' &&
        stringField(event, 'decision') !== 'mission_control_action_applied' &&
        stringField(event, 'decision') !== 'surface_control_action_applied' &&
        stringField(event, 'decision') !== 'mission_orchestration_event_started' &&
        stringField(event, 'decision') !== 'mission_orchestration_event_completed' &&
        stringField(event, 'decision') !== 'mission_orchestration_event_failed'
      ) {
        continue;
      }

      if (!details[eventId]) {
        details[eventId] = [];
      }
      details[eventId].push({
        ts: stringField(event, 'ts', new Date().toISOString()),
        decision: stringField(event, 'decision', 'event'),
        event_type: optionalStringField(event, 'event_type'),
        mission_id: optionalStringField(event, 'mission_id'),
        resource_id: optionalStringField(event, 'resource_id'),
        operation: optionalStringField(event, 'operation'),
        why: optionalStringField(event, 'why'),
        error: optionalStringField(event, 'error'),
      });
    } catch {
      // Ignore malformed lines.
    }
  }

  for (const key of Object.keys(details)) {
    details[key] = details[key].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
  }

  return details;
}

export function collectOwnerSummaries(
  options: IntelligenceObservationCollectionOptions = {}
): OwnerSummary[] {
  const summaries: OwnerSummary[] = [];
  const files = options.observationFiles || [
    pathResolver.shared('observability/channels/slack/missions.jsonl'),
    pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
  ];

  for (const file of files) {
    const safeFile = safeObservationPath(file);
    if (!safeFile) continue;
    const raw = safeReadFile(safeFile, { encoding: 'utf8' }) as string;
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = parseJsonRecord(line);
        if (!event) continue;
        if (
          stringField(event, 'decision', stringField(event, 'event_type')) !==
          'mission_owner_notified'
        )
          continue;
        summaries.push({
          ts: stringField(event, 'ts', new Date().toISOString()),
          mission_id: stringField(event, 'mission_id', 'unknown'),
          accepted_count: numberField(event, 'accepted_count'),
          reviewed_count: numberField(event, 'reviewed_count'),
          completed_count: numberField(event, 'completed_count'),
          requested_count: numberField(event, 'requested_count'),
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
}

export function collectBrowserSessions(
  options: BrowserObservationCollectionOptions = {}
): BrowserSessionSummary[] {
  const sessionDir = safeObservationDirectory(
    options.browserSessionsDir || pathResolver.shared('runtime/browser/sessions')
  );
  if (!sessionDir) return [];

  const sessions: BrowserSessionSummary[] = [];
  for (const entry of safeReaddir(sessionDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const filePath = safeObservationFile(sessionDir, entry);
      if (!filePath) continue;
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const parsed = parseJsonRecord(raw);
      const session = parseBrowserSessionSummary(parsed);
      if (!session) continue;
      sessions.push(session);
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}

export function collectBrowserConversationSessions(
  options: BrowserObservationCollectionOptions = {}
): BrowserConversationSessionSummary[] {
  const sessionDir = safeObservationDirectory(
    options.browserConversationSessionsDir ||
      pathResolver.shared('runtime/browser/conversation-sessions')
  );
  if (!sessionDir) return [];

  const sessions: BrowserConversationSessionSummary[] = [];
  for (const entry of safeReaddir(sessionDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const filePath = safeObservationFile(sessionDir, entry);
      if (!filePath) continue;
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const parsed = parseJsonRecord(raw);
      const session = parseBrowserConversationSessionSummary(parsed);
      if (!session) continue;
      sessions.push(session);
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}
