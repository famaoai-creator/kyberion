/**
 * Browser control session leases — the consent object behind `control_step`.
 *
 * A session is minted only after an operator approval; it binds control to one
 * canonical origin for a bounded lifetime. The host validates every step
 * against the session before delivery and the extension re-validates the same
 * view before executing — the session *is* the consent, so individual low-risk
 * steps need no per-click approval (the observe_tab per-click model is
 * unchanged). High-risk ops still require a per-step approval whose hash is
 * appended here once granted.
 *
 * Storage: `active/shared/runtime/browser-control/sessions/<session_id>.json`
 * plus `<session_id>.journal.jsonl` — flat, operator-local runtime state
 * (single-operator channel, same trust model as the bridge mailbox poll).
 */
import { randomUUID, createHash } from 'node:crypto';
import * as path from 'node:path';
import { appendJsonLine, readJsonIfPresent, writeJson } from '@agent/core/foundation/json';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlink,
} from '@agent/core/secure-io';
import { HIGH_RISK_OPERATIONS } from '@agent/core/browser/browser-extension-bridge';

export const BROWSER_CONTROL_SESSION_ROOT = 'active/shared/runtime/browser-control/sessions';
export const BROWSER_CONTROL_SESSION_TTL_MS = 30 * 60_000;
export const BROWSER_CONTROL_MAX_TTL_MS = 60 * 60_000;

/** Ops a session's risk ceiling can auto-execute; anything else needs per-step approval. */
export const OBSERVE_ONLY_OPS = new Set([
  'snapshot',
  'screenshot',
  'extract_text_ref',
  'list_tabs',
]);

export interface BrowserControlSession {
  session_id: string;
  lease_id: string;
  origin: string;
  risk_ceiling: 'observe' | 'low';
  status: 'active' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  requested_by: { actor_id: string; mission_id?: string };
  approval_request_id: string;
  /** sha256 hashes of individually approved high-risk step payloads. */
  approved_step_hashes: string[];
  label?: string;
}

const SESSION_ID_PATTERN = /^BCS-[0-9a-f-]{36}$/u;

function sessionPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`[BROWSER_CONTROL_INVALID] malformed session_id`);
  }
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(path.posix.join(BROWSER_CONTROL_SESSION_ROOT, `${sessionId}.json`)),
    { rootDir: pathResolver.rootDir(), allowMissingLeaf: true }
  );
}

function journalPath(sessionId: string): string {
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      path.posix.join(BROWSER_CONTROL_SESSION_ROOT, `${sessionId}.journal.jsonl`)
    ),
    { rootDir: pathResolver.rootDir(), allowMissingLeaf: true }
  );
}

export function loadBrowserControlSession(sessionId: string): BrowserControlSession | null {
  const record = readJsonIfPresent<BrowserControlSession>(sessionPath(sessionId));
  if (!record || record.session_id !== sessionId) return null;
  return record;
}

function saveSession(session: BrowserControlSession): void {
  const file = sessionPath(session.session_id);
  safeMkdir(path.dirname(file));
  writeJson(file, session);
}

export function mintBrowserControlSession(input: {
  origin: string;
  risk_ceiling?: 'observe' | 'low';
  requested_by: { actor_id: string; mission_id?: string };
  approval_request_id: string;
  label?: string;
  ttl_ms?: number;
  now?: Date;
}): BrowserControlSession {
  const now = input.now ?? new Date();
  const ttl = Math.min(input.ttl_ms ?? BROWSER_CONTROL_SESSION_TTL_MS, BROWSER_CONTROL_MAX_TTL_MS);
  const session: BrowserControlSession = {
    session_id: `BCS-${randomUUID()}`,
    lease_id: `LCS-${randomUUID()}`,
    origin: input.origin,
    risk_ceiling: input.risk_ceiling ?? 'low',
    status: 'active',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    requested_by: input.requested_by,
    approval_request_id: input.approval_request_id,
    approved_step_hashes: [],
    ...(input.label ? { label: input.label } : {}),
  };
  saveSession(session);
  return session;
}

export function listBrowserControlSessions(now: Date = new Date()): BrowserControlSession[] {
  const dir = pathResolver.rootResolve(BROWSER_CONTROL_SESSION_ROOT);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return readJsonIfPresent<BrowserControlSession>(path.join(dir, name));
      } catch {
        return null;
      }
    })
    .filter((record): record is BrowserControlSession => Boolean(record))
    .map((session) => ({
      ...session,
      status:
        session.status === 'active' && Date.parse(session.expires_at) <= now.getTime()
          ? 'expired'
          : session.status,
    }));
}

export function revokeBrowserControlSession(sessionId: string): BrowserControlSession | null {
  const session = loadBrowserControlSession(sessionId);
  if (!session) return null;
  session.status = 'revoked';
  saveSession(session);
  return session;
}

/** Hash a step payload the same way the lease-side approval records it. */
export function hashControlStep(step: unknown): string {
  return createHash('sha256').update(JSON.stringify(step ?? null)).digest('hex');
}

export type SessionAdmission =
  | { ok: true; session: BrowserControlSession }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'revoked'
        | 'expired'
        | 'origin_mismatch'
        | 'above_ceiling'
        | 'approval_required';
      detail: string;
      approval_required?: boolean;
    };

/**
 * Decide whether one step may run under a session. High-risk ops pass only
 * when their hash was already approved (callers create the approval request
 * and re-admit after grant).
 */
export function admitControlStep(
  sessionId: string,
  step: { op: string; [key: string]: unknown },
  now: Date = new Date()
): SessionAdmission {
  let session: BrowserControlSession | null;
  try {
    session = loadBrowserControlSession(sessionId);
  } catch {
    return { ok: false, reason: 'not_found', detail: `session ${sessionId} not found` };
  }
  if (!session) {
    return { ok: false, reason: 'not_found', detail: `session ${sessionId} not found` };
  }
  if (session.status === 'revoked') {
    return { ok: false, reason: 'revoked', detail: `session ${sessionId} is revoked` };
  }
  if (Date.parse(session.expires_at) <= now.getTime()) {
    if (session.status === 'active') {
      session.status = 'expired';
      saveSession(session);
    }
    return { ok: false, reason: 'expired', detail: `session ${sessionId} expired` };
  }
  if (session.risk_ceiling === 'observe' && !OBSERVE_ONLY_OPS.has(step.op)) {
    return {
      ok: false,
      reason: 'above_ceiling',
      detail: `op ${step.op} exceeds the observe-only ceiling of session ${sessionId}`,
    };
  }
  if (HIGH_RISK_OPERATIONS.has(step.op as never)) {
    const hash = hashControlStep(step);
    if (!session.approved_step_hashes.includes(hash)) {
      return {
        ok: false,
        reason: 'approval_required',
        detail: `high-risk op ${step.op} requires a per-step approval`,
        approval_required: true,
      };
    }
  }
  return { ok: true, session };
}

export function recordApprovedControlStep(
  sessionId: string,
  step: { op: string; [key: string]: unknown }
): BrowserControlSession | null {
  return withLockSync(`browser-control-${sessionId}`, () => {
    const session = loadBrowserControlSession(sessionId);
    if (!session) return null;
    const hash = hashControlStep(step);
    if (!session.approved_step_hashes.includes(hash)) {
      session.approved_step_hashes.push(hash);
      saveSession(session);
    }
    return session;
  });
}

export function appendBrowserControlJournal(
  sessionId: string,
  entry: Record<string, unknown>
): void {
  const file = journalPath(sessionId);
  safeMkdir(path.dirname(file));
  appendJsonLine(file, { ts: new Date().toISOString(), ...entry });
}

// ---------------------------------------------------------------------------
// Pending high-risk steps — stored by approval request id so a granted
// approval can resume the exact step it approved (same payload, same hash).
// ---------------------------------------------------------------------------

export interface PendingControlStep {
  approval_request_id: string;
  session_id: string;
  step: { op: string; step_id: string; [key: string]: unknown };
  created_at: string;
}

function pendingStepPath(approvalRequestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(approvalRequestId)) {
    throw new Error('[BROWSER_CONTROL_INVALID] malformed approval_request_id');
  }
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      path.posix.join(BROWSER_CONTROL_SESSION_ROOT, 'pending', `${approvalRequestId}.json`)
    ),
    { rootDir: pathResolver.rootDir(), allowMissingLeaf: true }
  );
}

export function savePendingControlStep(entry: PendingControlStep): void {
  const file = pendingStepPath(entry.approval_request_id);
  safeMkdir(path.dirname(file));
  writeJson(file, entry);
}

export function loadPendingControlStep(approvalRequestId: string): PendingControlStep | null {
  return readJsonIfPresent<PendingControlStep>(pendingStepPath(approvalRequestId));
}

export function clearPendingControlStep(approvalRequestId: string): void {
  const file = pendingStepPath(approvalRequestId);
  if (safeExistsSync(file)) safeUnlink(file);
}
