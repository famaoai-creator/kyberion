/**
 * Long-session nudge for host CLI hooks (Claude Code / Devin).
 *
 * Context cost grows with session length × turns. The weekly usage report
 * found single sessions with thousands of recorded events; this keeps a tiny
 * per-session counter (prompts + audited tool events) so the
 * UserPromptSubmit hook can suggest a handoff + `/clear` once a session runs
 * long — without scanning the audit chain on every prompt.
 *
 * State: one small JSON file per host session under
 * `active/shared/runtime/session-length/` (14-day retention entry). Counters
 * are approximate by design: parallel tool hooks of one session can race on
 * the read-modify-write and drop an increment, which only delays the nudge.
 * Every entry point is fail-open — a broken counter must never fail a hook.
 */

import * as path from 'node:path';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';

/** Prompts in one session after which the hook suggests a handoff. */
export const SESSION_LENGTH_PROMPT_THRESHOLD = 150;
/** Audited tool events (Bash/Write/Edit…) in one session after which the hook suggests a handoff. */
export const SESSION_LENGTH_TOOL_THRESHOLD = 1500;
/** Once over a threshold, repeat the hint at most every this many prompts. */
export const SESSION_LENGTH_RENUDGE_EVERY_PROMPTS = 25;

const STATE_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export interface SessionLengthState {
  version: 1;
  session_id: string;
  prompts: number;
  tool_events: number;
  /** Prompt count at which the last hint was emitted; null = never nudged. */
  last_nudged_prompt: number | null;
  updated_at: string;
}

function normalizeKey(provider: string, sessionId: unknown): string | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const host = String(provider || '').trim();
  if (!id || !SESSION_ID_PATTERN.test(id) || !/^[a-z0-9-]{1,32}$/u.test(host)) return null;
  return `${host}-${id}`;
}

export function sessionLengthStatePath(provider: string, sessionId: unknown): string | null {
  const key = normalizeKey(provider, sessionId);
  return key ? pathResolver.shared(`runtime/session-length/${key}.json`) : null;
}

function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function loadState(filePath: string, sessionId: string): SessionLengthState {
  const fresh: SessionLengthState = {
    version: STATE_VERSION,
    session_id: sessionId,
    prompts: 0,
    tool_events: 0,
    last_nudged_prompt: null,
    updated_at: nowIso(),
  };
  try {
    const raw = readJsonIfPresent<Record<string, unknown>>(filePath);
    if (!raw || raw.version !== STATE_VERSION || raw.session_id !== sessionId) return fresh;
    return {
      ...fresh,
      prompts: count(raw.prompts),
      tool_events: count(raw.tool_events),
      last_nudged_prompt:
        raw.last_nudged_prompt === null || raw.last_nudged_prompt === undefined
          ? null
          : count(raw.last_nudged_prompt),
    };
  } catch {
    return fresh;
  }
}

function saveState(filePath: string, state: SessionLengthState): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  writeJson(filePath, { ...state, updated_at: nowIso() });
}

/**
 * Pure decision: should this prompt carry the handoff hint? True when a
 * threshold is crossed and the last hint is at least
 * SESSION_LENGTH_RENUDGE_EVERY_PROMPTS prompts old (or none was given).
 */
export function shouldNudgeSessionLength(state: SessionLengthState): boolean {
  const over =
    state.prompts >= SESSION_LENGTH_PROMPT_THRESHOLD ||
    state.tool_events >= SESSION_LENGTH_TOOL_THRESHOLD;
  if (!over) return false;
  return (
    state.last_nudged_prompt === null ||
    state.prompts - state.last_nudged_prompt >= SESSION_LENGTH_RENUDGE_EVERY_PROMPTS
  );
}

export function formatSessionLengthHint(state: SessionLengthState): string {
  return (
    `This session is long (${state.prompts} prompts, ${state.tool_events} tool events): ` +
    'write a short handoff note (goal, state, next step, open files) and /clear to cap context cost.'
  );
}

/**
 * Count one user prompt and return the handoff hint line when due, else null.
 * Never throws.
 */
export function recordSessionPromptForNudge(provider: string, sessionId: unknown): string | null {
  try {
    const filePath = sessionLengthStatePath(provider, sessionId);
    if (!filePath) return null;
    const state = loadState(filePath, String(sessionId).trim());
    state.prompts += 1;
    const nudge = shouldNudgeSessionLength(state);
    if (nudge) state.last_nudged_prompt = state.prompts;
    saveState(filePath, state);
    return nudge ? formatSessionLengthHint(state) : null;
  } catch {
    return null;
  }
}

/** Count one audited tool event for the session. Never throws. */
export function recordSessionToolEventForNudge(provider: string, sessionId: unknown): void {
  try {
    const filePath = sessionLengthStatePath(provider, sessionId);
    if (!filePath) return;
    const state = loadState(filePath, String(sessionId).trim());
    state.tool_events += 1;
    saveState(filePath, state);
  } catch {
    // best-effort; never fail the hook on a counter
  }
}

/** Read the current counters (tests, diagnostics). Null when the session id is unusable. */
export function loadSessionLengthState(
  provider: string,
  sessionId: unknown
): SessionLengthState | null {
  const filePath = sessionLengthStatePath(provider, sessionId);
  return filePath ? loadState(filePath, String(sessionId).trim()) : null;
}
