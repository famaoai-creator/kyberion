/**
 * co-session-hook.ts — provider-agnostic bridge between host CLI hook events
 * and the same-checkout co-session layer.
 *
 * Hook processes are short-lived: a session event fires, this bridge performs
 * the co-session file operation (join / heartbeat / handoff drain / lease
 * gate / release), and the provider's hook script formats the result into the
 * CLI's native output shape. Everything here is fail-open except the lease
 * gate itself — a broken co-session store must never wedge a user session,
 * and the lease remains advisory where hooks cannot enforce it.
 *
 * @see knowledge/product/architecture/co-session-coordination.md
 */
import { createLogger } from '../logger.js';
import {
  CO_SESSION_PROVIDERS,
  CoSessionError,
  type CoSessionHandoff,
  type CoSessionProvider,
  coSessionHandoffTargets,
  getCoSessionLease,
  getCurrentCoSessionId,
  heartbeatCoSession,
  joinCoSession,
  leaveCoSession,
  listCoSessionHandoffs,
  listCoSessionPresence,
  normalizeCoSessionPath,
} from '../co-session.js';

const logger = createLogger('co-session-hook');

/**
 * Claude Code and Gemini CLI both pass `session_id`; the pid fallback is
 * deliberately unstable (per hook process) and is only used for read-side
 * identity — join/drain/end skip keyless invocations. OS pid reuse could, in
 * principle, collide a dead holder's `provider-<pid>`; lease TTL backstops.
 */
export function resolveHookParticipantId(provider: string, sessionKey?: string): string {
  const raw = sessionKey?.trim() || `${process.pid}`;
  const key = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${provider}-${key}`;
}

export interface CoSessionHookIdentity {
  provider: CoSessionProvider;
  participant_id: string;
}

function toProvider(value: string): CoSessionProvider | undefined {
  return (CO_SESSION_PROVIDERS as readonly string[]).includes(value)
    ? (value as CoSessionProvider)
    : undefined;
}

function resolveIdentity(provider: string, sessionKey?: string): CoSessionHookIdentity | undefined {
  const p = toProvider(provider);
  if (!p) return undefined;
  // Without a stable session key the pid fallback would mint a new
  // participant per hook process — pointless presence churn. Callers that
  // only evaluate (lease gate) don't need identity; join/drain/end no-op.
  if (!sessionKey?.trim()) return undefined;
  return { provider: p, participant_id: resolveHookParticipantId(p, sessionKey) };
}

function isAbsence(error: unknown): boolean {
  return (
    error instanceof CoSessionError &&
    (error.code === 'no_session' || error.code === 'not_found' || error.code === 'closed')
  );
}

/**
 * Session-start: join the sticky (or explicit) co-session and heartbeat.
 * Silent when no session exists — starting one is an explicit operator act.
 */
export function coSessionHookJoin(input: {
  provider: string;
  session_key?: string;
  session_id?: string;
  note?: string;
}): { joined: boolean; session_id?: string; participant_id?: string } {
  const identity = resolveIdentity(input.provider, input.session_key);
  if (!identity) return { joined: false };
  try {
    joinCoSession({
      provider: identity.provider,
      session_id: input.session_id,
      participant_id: identity.participant_id,
      note: input.note ?? 'joined via provider hook',
    });
    return {
      joined: true,
      session_id: input.session_id ?? getCurrentCoSessionId(),
      participant_id: identity.participant_id,
    };
  } catch (error) {
    if (!isAbsence(error)) {
      logger.warn(
        `co-session hook join failed — ${(error as Error)?.message ?? error} | continuing without presence | provider: ${input.provider}`
      );
    }
    return { joined: false };
  }
}

export interface PendingHandoffDigest {
  session_id: string;
  participant_id: string;
  handoffs: CoSessionHandoff[];
}

/**
 * Prompt-turn: heartbeat, then collect pending handoffs addressed to this
 * participant, this provider, or broadcast. Never acks — ack is an explicit
 * agent decision via `co-session handoff ack`.
 */
export function coSessionHookDrain(input: {
  provider: string;
  session_key?: string;
  session_id?: string;
}): PendingHandoffDigest | undefined {
  const identity = resolveIdentity(input.provider, input.session_key);
  if (!identity) return undefined;
  try {
    const session_id = input.session_id ?? getCurrentCoSessionId();
    if (!session_id) return undefined;
    // Throttle: one fresh presence row already proves liveness — appending a
    // presence row + heartbeat event on every prompt grows the journals
    // unboundedly for no signal.
    const fresh = listCoSessionPresence(session_id).some(
      (row) => row.participant_id === identity.participant_id
    );
    if (!fresh) {
      heartbeatCoSession({
        provider: identity.provider,
        session_id,
        participant_id: identity.participant_id,
      });
    }
    const handoffs = listCoSessionHandoffs(session_id, { pendingOnly: true }).filter((h) =>
      coSessionHandoffTargets(h, identity.provider, identity.participant_id)
    );
    return { session_id, participant_id: identity.participant_id, handoffs };
  } catch (error) {
    if (!isAbsence(error)) {
      logger.warn(
        `co-session hook drain failed — ${(error as Error)?.message ?? error} | continuing without handoffs | provider: ${input.provider}`
      );
    }
    return undefined;
  }
}

const MAX_LISTED_HANDOFFS = 10;

/** Markdown block for context injection; empty string when nothing is pending. */
export function formatPendingHandoffs(digest: PendingHandoffDigest | undefined): string {
  if (!digest || digest.handoffs.length === 0) return '';
  const shown = digest.handoffs.slice(0, MAX_LISTED_HANDOFFS);
  const rest = digest.handoffs.length - shown.length;
  const lines = [
    `Co-session ${digest.session_id}: ${digest.handoffs.length} pending handoff(s) for ${digest.participant_id}:`,
  ];
  for (const h of shown) {
    const subject = h.subject ? ` — ${h.subject}` : '';
    lines.push(`- [${h.kind}] ${h.handoff_id} from ${h.from_provider}${subject}`);
  }
  if (rest > 0) lines.push(`- …and ${rest} more`);
  lines.push(
    `Inspect with \`pnpm exec tsx scripts/co_session.ts handoff --action list --pending-only\`; ` +
      `ack with \`--action ack --as <provider> --handoff-id <id> --participant-id ${digest.participant_id}\`.`
  );
  return lines.join('\n');
}

export interface LeaseGateVerdict {
  decision: 'allow' | 'deny';
  reason?: string;
}

/**
 * Pre-write gate: deny when another participant holds an active lease on the
 * target path. This is the point where the advisory lease becomes an actual
 * write fence — for hook-equipped CLIs only. Fail-open when the store cannot
 * be read (advisory baseline is preserved).
 */
export function coSessionHookLeaseGate(input: {
  provider: string;
  session_key?: string;
  participant_id?: string;
  file_path: string;
  session_id?: string;
}): LeaseGateVerdict {
  const participant_id =
    input.participant_id?.trim() || resolveHookParticipantId(input.provider, input.session_key);
  try {
    const repoPath = normalizeCoSessionPath(input.file_path);
    const session_id = input.session_id ?? getCurrentCoSessionId();
    if (!session_id) return { decision: 'allow' };
    const { session_status, lease } = getCoSessionLease(session_id, input.file_path);
    // Leases on a closed session never block (close force-releases first;
    // this is only a defense against a stranded record).
    if (session_status !== 'open') return { decision: 'allow' };
    if (!lease || lease.status !== 'active') return { decision: 'allow' };
    if (
      lease.holder_provider === input.provider &&
      lease.holder_participant_id === participant_id
    ) {
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason:
        `Path '${repoPath}' is leased by ${lease.holder_provider}/${lease.holder_participant_id} ` +
        `until ${lease.expires_at} (co-session ${session_id}). ` +
        `List leases with \`co-session lease --action list\`, request access via \`co-session handoff\`, ` +
        `or wait for expiry.`,
    };
  } catch (error) {
    if (!isAbsence(error)) {
      logger.warn(
        `co-session lease gate could not be evaluated — ${(error as Error)?.message ?? error} | allowing (advisory) | path: ${input.file_path}`
      );
    }
    return { decision: 'allow' };
  }
}

/**
 * Session end: release every active lease this participant holds, then leave.
 * Best-effort — the TTL reclaim is the safety net when a session dies hard.
 */
export function coSessionHookEnd(input: {
  provider: string;
  session_key?: string;
  session_id?: string;
}): { released_leases: number } {
  const identity = resolveIdentity(input.provider, input.session_key);
  if (!identity) return { released_leases: 0 };
  try {
    const result = leaveCoSession({
      provider: identity.provider,
      session_id: input.session_id,
      participant_id: identity.participant_id,
    });
    return result;
  } catch (error) {
    if (!isAbsence(error)) {
      logger.warn(
        `co-session hook end failed — ${(error as Error)?.message ?? error} | leases expire by TTL | provider: ${input.provider}`
      );
    }
    return { released_leases: 0 };
  }
}
