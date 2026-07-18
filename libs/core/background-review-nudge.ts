/**
 * HA-01 nudge counters.
 *
 * Counters are persisted per logical session so a worker restart carries the
 * remainder forward. Crossing either threshold reserves one asynchronous
 * review and preserves the modulo remainder; the main worker is never blocked.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

const STATE_VERSION = 1;
const DEFAULT_THRESHOLD = 10;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export interface BackgroundReviewNudgeConfig {
  turnThreshold?: number;
  toolThreshold?: number;
}

export interface BackgroundReviewNudgeState {
  version: 1;
  session_id: string;
  turns_since_review: number;
  tool_calls_since_review: number;
  review_pending: boolean;
  updated_at: string;
}

export interface BackgroundReviewNudgeResult {
  review_due: boolean;
  reset: boolean;
  state: BackgroundReviewNudgeState;
}

function normalizeSessionId(value: string): string {
  const sessionId = String(value || '').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`[POLICY_VIOLATION] Invalid background review session id: ${sessionId}`);
  }
  return sessionId;
}

function threshold(value: number | undefined): number {
  return Math.max(1, Math.floor(Number(value) || DEFAULT_THRESHOLD));
}

function statePath(sessionId: string): string {
  return pathResolver.shared(
    `runtime/background-review/nudge/${normalizeSessionId(sessionId)}.json`
  );
}

function defaultState(sessionId: string): BackgroundReviewNudgeState {
  return {
    version: STATE_VERSION,
    session_id: normalizeSessionId(sessionId),
    turns_since_review: 0,
    tool_calls_since_review: 0,
    review_pending: false,
    updated_at: new Date().toISOString(),
  };
}

function normalizeState(raw: unknown, sessionId: string): BackgroundReviewNudgeState {
  const fallback = defaultState(sessionId);
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  if (value.version !== STATE_VERSION || value.session_id !== fallback.session_id) return fallback;
  return {
    ...fallback,
    turns_since_review: Math.max(0, Math.floor(Number(value.turns_since_review) || 0)),
    tool_calls_since_review: Math.max(0, Math.floor(Number(value.tool_calls_since_review) || 0)),
    review_pending: value.review_pending === true,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : fallback.updated_at,
  };
}

function loadState(sessionId: string): BackgroundReviewNudgeState {
  const normalized = normalizeSessionId(sessionId);
  const filePath = statePath(normalized);
  if (!safeExistsSync(filePath)) return defaultState(normalized);
  try {
    return normalizeState(
      JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }) || '{}')),
      normalized
    );
  } catch {
    // A corrupt nudge file must not block the main worker; start a clean
    // counter while preserving the same logical session identity.
    return defaultState(normalized);
  }
}

function saveState(state: BackgroundReviewNudgeState): BackgroundReviewNudgeState {
  const filePath = statePath(state.session_id);
  const parent = path.dirname(filePath);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  const next = { ...state, updated_at: new Date().toISOString() };
  safeWriteFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function resetsNudge(operation: string | undefined): boolean {
  const normalized = String(operation || '')
    .trim()
    .toLowerCase();
  return normalized.startsWith('skill:') || normalized.startsWith('knowledge:');
}

export function loadBackgroundReviewNudgeState(sessionId: string): BackgroundReviewNudgeState {
  return loadState(sessionId);
}

/**
 * Record one worker activity. Skill/knowledge operations reset both counters;
 * all other turns/tool calls increment their respective counter.
 */
export function recordBackgroundReviewActivity(input: {
  sessionId: string;
  activity: 'turn' | 'tool';
  operation?: string;
  config?: BackgroundReviewNudgeConfig;
}): BackgroundReviewNudgeResult {
  const state = loadState(input.sessionId);
  if (resetsNudge(input.operation)) {
    const next = saveState({
      ...state,
      turns_since_review: 0,
      tool_calls_since_review: 0,
      review_pending: false,
    });
    return { review_due: false, reset: true, state: next };
  }

  const nextTurns = state.turns_since_review + (input.activity === 'turn' ? 1 : 0);
  const nextTools = state.tool_calls_since_review + (input.activity === 'tool' ? 1 : 0);
  const turnThreshold = threshold(input.config?.turnThreshold);
  const toolThreshold = threshold(input.config?.toolThreshold);
  const crossed = nextTurns >= turnThreshold || nextTools >= toolThreshold;
  const due = crossed && !state.review_pending;
  const next = saveState({
    ...state,
    // Preserve work after the threshold so a restart resumes from the
    // remainder instead of replaying the entire session.
    turns_since_review: crossed ? nextTurns % turnThreshold : nextTurns,
    tool_calls_since_review: crossed ? nextTools % toolThreshold : nextTools,
    review_pending: state.review_pending || due,
  });
  return { review_due: due, reset: false, state: next };
}

/** Mark the reserved review as finished; any modulo remainder is retained. */
export function completeBackgroundReview(sessionId: string): BackgroundReviewNudgeState {
  const state = loadState(sessionId);
  return saveState({ ...state, review_pending: false });
}

/** Cancel a reservation without discarding the accumulated remainder. */
export function cancelBackgroundReview(sessionId: string): BackgroundReviewNudgeState {
  const state = loadState(sessionId);
  return saveState({ ...state, review_pending: false });
}

export function backgroundReviewNudgeStatePath(sessionId: string): string {
  return statePath(sessionId);
}
