import * as path from 'node:path';
import { isRecord, readJson } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';

export interface SessionPaths {
  base: string;
  in: string;
  out: string;
  state: string;
}

export interface PersistedSessionState {
  id: string;
  name: string;
  ts?: string;
  pid?: number;
  active?: boolean;
  active_brain?: string;
  lastActive?: number;
  createdAt?: string;
  connected?: boolean;
}

export interface SessionRuntimeSummary {
  id: string;
  name: string;
  active_brain?: string;
  lastActive: number;
  connected: boolean;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value.trim());
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('[TERMINAL_INPUT_INVALID] session id must be a string');
  }
  const id = value.trim();
  if (!isValidSessionId(id)) {
    throw new Error(
      '[TERMINAL_INPUT_INVALID] session id must be 1-128 characters of letters, numbers, dot, underscore, or hyphen'
    );
  }
  return id;
}

function requestObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[TERMINAL_INPUT_INVALID] message must be an object');
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`[TERMINAL_INPUT_INVALID] unexpected field '${unexpected}'`);
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`[TERMINAL_INPUT_INVALID] ${key} must be a string`);
  }
  return value;
}

function optionalDimension(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error(`[TERMINAL_INPUT_INVALID] ${key} must be an integer between 1 and 500`);
  }
  return value;
}

export interface TerminalSessionCreateInput {
  id?: string;
  name?: string;
}

export function parseTerminalSessionCreateInput(value: unknown): TerminalSessionCreateInput {
  const record = requestObject(value);
  assertKeys(record, ['id', 'name']);
  const rawId = optionalString(record, 'id');
  return {
    ...(rawId?.trim() ? { id: parseSessionId(rawId) } : {}),
    ...(record.name !== undefined ? { name: optionalString(record, 'name') } : {}),
  };
}

export type TerminalSocketMessage =
  | { type: 'init'; sessionId?: string; name?: string; cols?: number; rows?: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export interface TerminalControlRequest {
  text?: string;
  stimulus_id?: string;
  brain_profile?: string;
}

/** Validate a file-backed request before the terminal watcher touches a PTY. */
export function parseTerminalControlRequest(value: unknown): TerminalControlRequest | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['text', 'stimulus_id', 'brain_profile']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  for (const key of ['text', 'stimulus_id', 'brain_profile'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  const text = typeof value.text === 'string' ? value.text : undefined;
  const stimulusId = typeof value.stimulus_id === 'string' ? value.stimulus_id.trim() : undefined;
  const brainProfile =
    typeof value.brain_profile === 'string' ? value.brain_profile.trim() : undefined;
  if (text === undefined && !stimulusId) return null;
  if (text !== undefined && text.length === 0 && !stimulusId) return null;
  if (text !== undefined && text.length > 100_000) return null;
  if (stimulusId && stimulusId.length > 256) return null;
  if (brainProfile && brainProfile.length > 256) return null;
  return {
    ...(text !== undefined ? { text } : {}),
    ...(stimulusId ? { stimulus_id: stimulusId } : {}),
    ...(brainProfile ? { brain_profile: brainProfile } : {}),
  };
}

export function parseTerminalSocketMessage(value: unknown): TerminalSocketMessage {
  const record = requestObject(value);
  if (record.type === 'init') {
    assertKeys(record, ['type', 'sessionId', 'name', 'cols', 'rows']);
    const rawSessionId = optionalString(record, 'sessionId');
    return {
      type: 'init',
      ...(rawSessionId?.trim() ? { sessionId: parseSessionId(rawSessionId) } : {}),
      ...(record.name !== undefined ? { name: optionalString(record, 'name') } : {}),
      ...(record.cols !== undefined ? { cols: optionalDimension(record, 'cols') } : {}),
      ...(record.rows !== undefined ? { rows: optionalDimension(record, 'rows') } : {}),
    };
  }
  if (record.type === 'input') {
    assertKeys(record, ['type', 'data']);
    const data = optionalString(record, 'data');
    if (data === undefined) {
      throw new Error('[TERMINAL_INPUT_INVALID] data must be a string');
    }
    return { type: 'input', data };
  }
  if (record.type === 'resize') {
    assertKeys(record, ['type', 'cols', 'rows']);
    const cols = optionalDimension(record, 'cols');
    const rows = optionalDimension(record, 'rows');
    if (cols === undefined || rows === undefined) {
      throw new Error('[TERMINAL_INPUT_INVALID] resize requires cols and rows');
    }
    return { type: 'resize', cols, rows };
  }
  throw new Error('[TERMINAL_INPUT_INVALID] unsupported message type');
}

export function isLikelyTerminalControlPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function buildSessionPaths(runtimeBase: string, sessionId: string): SessionPaths {
  const safeSessionId = parseSessionId(sessionId);
  const base = path.join(runtimeBase, safeSessionId);
  return {
    base,
    in: path.join(base, 'in'),
    out: path.join(base, 'out'),
    state: path.join(base, 'state.json'),
  };
}

export function normalizeSessionName(name: string | undefined, sessionId: string): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, 80) : `Session ${sessionId}`;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

/** Normalize persisted terminal state before it can drive restore or pruning. */
export function parsePersistedSessionState(value: unknown): PersistedSessionState | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    'id',
    'name',
    'ts',
    'pid',
    'active',
    'active_brain',
    'lastActive',
    'createdAt',
    'connected',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isValidSessionId(value.id) || typeof value.name !== 'string') return null;
  if (value.ts !== undefined && !isTimestamp(value.ts)) return null;
  if (
    value.pid !== undefined &&
    (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 0)
  ) {
    return null;
  }
  if (value.active !== undefined && typeof value.active !== 'boolean') return null;
  if (value.active_brain !== undefined && typeof value.active_brain !== 'string') return null;
  if (
    value.lastActive !== undefined &&
    (typeof value.lastActive !== 'number' ||
      !Number.isFinite(value.lastActive) ||
      value.lastActive < 0)
  ) {
    return null;
  }
  if (value.createdAt !== undefined && !isTimestamp(value.createdAt)) return null;
  if (value.connected !== undefined && typeof value.connected !== 'boolean') return null;
  const ts = value.ts as string | undefined;
  const pid = value.pid as number | undefined;
  const active = value.active as boolean | undefined;
  const activeBrain = value.active_brain as string | undefined;
  const lastActive = value.lastActive as number | undefined;
  const createdAt = value.createdAt as string | undefined;
  const connected = value.connected as boolean | undefined;
  return {
    id: value.id,
    name: value.name,
    ...(ts !== undefined ? { ts } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(activeBrain !== undefined ? { active_brain: activeBrain } : {}),
    ...(lastActive !== undefined ? { lastActive } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(connected !== undefined ? { connected } : {}),
  };
}

export function readPersistedSessionState(statePath: string): PersistedSessionState | null {
  try {
    const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeStatePath) || !safeLstat(safeStatePath).isFile()) return null;
    return parsePersistedSessionState(readJson<unknown>(safeStatePath));
  } catch {
    return null;
  }
}

export function listPersistedSessionStates(runtimeBase: string): PersistedSessionState[] {
  let safeRuntimeBase: string;
  try {
    safeRuntimeBase = assertSafeRepositoryPath(runtimeBase, { allowMissingLeaf: true });
    if (!safeExistsSync(safeRuntimeBase) || !safeLstat(safeRuntimeBase).isDirectory()) return [];
  } catch {
    return [];
  }

  const states = safeReaddir(safeRuntimeBase)
    .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId))
    .map((sessionId) => {
      const state = readPersistedSessionState(buildSessionPaths(safeRuntimeBase, sessionId).state);
      return state?.id === sessionId ? state : null;
    })
    .filter((state): state is PersistedSessionState => Boolean(state));

  return states
    .filter((state) => isValidSessionId(state.id))
    .sort((left, right) => (right.lastActive || 0) - (left.lastActive || 0));
}

export function mergeSessionSummaries(
  persisted: PersistedSessionState[],
  runtimeSessions: SessionRuntimeSummary[]
): SessionRuntimeSummary[] {
  const merged = new Map<string, SessionRuntimeSummary>();

  for (const state of persisted) {
    merged.set(state.id, {
      id: state.id,
      name: normalizeSessionName(state.name, state.id),
      active_brain: state.active_brain || 'none',
      lastActive: state.lastActive || 0,
      connected: Boolean(state.connected),
    });
  }

  for (const session of runtimeSessions) {
    merged.set(session.id, {
      ...session,
      name: normalizeSessionName(session.name, session.id),
      active_brain: session.active_brain || 'none',
    });
  }

  return Array.from(merged.values()).sort((left, right) => right.lastActive - left.lastActive);
}
