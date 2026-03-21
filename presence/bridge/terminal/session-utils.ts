import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';

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

export function buildSessionPaths(runtimeBase: string, sessionId: string): SessionPaths {
  const base = path.join(runtimeBase, sessionId);
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

export function readPersistedSessionState(statePath: string): PersistedSessionState | null {
  if (!safeExistsSync(statePath)) {
    return null;
  }

  try {
    const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content) as PersistedSessionState;
  } catch {
    return null;
  }
}

export function listPersistedSessionStates(runtimeBase: string): PersistedSessionState[] {
  if (!safeExistsSync(runtimeBase)) {
    return [];
  }

  const states = safeReaddir(runtimeBase)
    .map(sessionId => readPersistedSessionState(buildSessionPaths(runtimeBase, sessionId).state))
    .filter((state): state is PersistedSessionState => Boolean(state));

  return states.sort((left, right) => (right.lastActive || 0) - (left.lastActive || 0));
}

export function mergeSessionSummaries(
  persisted: PersistedSessionState[],
  runtimeSessions: SessionRuntimeSummary[],
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
