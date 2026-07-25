/**
 * SO-03: typed steering-authority check for a conversation thread's mission
 * ownership, plus a UX-contract-shaped Japanese rejection formatter.
 *
 * `getSessionForThread` (SO-02) tells you whether a thread has an active
 * {@link OrchestratorSessionRecord} in the journal. That alone is not
 * sufficient to authorize a steering turn (SO-04): the journal record can be
 * `active` while its underlying cross-process ownership lease (SO-03,
 * `mission-ownership:<MISSION_ID>` in work-coordination) has separately
 * expired, or been reclaimed after this process's journal projection went
 * stale. This module is the single choke point SO-04 calls before routing a
 * steering turn (status / checkpoint / gate / pause / resume / finish) to
 * the SO-01 lifecycle facade: it re-verifies the lease live against
 * work-coordination — never trusts the journal projection alone — and throws
 * a typed, UX-contract-formattable rejection otherwise.
 */
import {
  deriveMissionOwnershipItemId,
  deriveSurfaceSessionId,
  listOrchestratorSessions,
  normalizeOrchestratorMissionId,
  type OrchestratorSessionRecord,
} from './orchestrator-session.js';
import { listActiveWorkLeases } from './work-coordination.js';
import { validateSurfaceUxContract } from './surface-ux-contract.js';

export interface AssertSurfaceSteeringAuthorityParams {
  surface: string;
  channel?: string;
  threadTs?: string;
  missionId: string;
}

export const SURFACE_STEERING_AUTHORITY_ERROR_CASES = [
  'no_session_for_thread',
  'different_mission',
  'session_released',
  'lease_expired',
] as const;
export type SurfaceSteeringAuthorityErrorCase =
  (typeof SURFACE_STEERING_AUTHORITY_ERROR_CASES)[number];

/**
 * Thrown by {@link assertSurfaceSteeringAuthority} when a thread may not
 * steer the mission it named. `caseId` is a stable, switchable discriminant
 * for callers (SO-04's routing, `formatSteeringRejection` below) — never
 * pattern-match on `message`.
 */
export class SurfaceSteeringAuthorityError extends Error {
  constructor(
    public readonly caseId: SurfaceSteeringAuthorityErrorCase,
    public readonly params: AssertSurfaceSteeringAuthorityParams,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(
      `[surface-steering-authority] thread (${params.surface}:${params.channel ?? 'default'}:` +
        `${params.threadTs ?? 'default'}) may not steer mission ${params.missionId}: ${caseId}`
    );
    this.name = 'SurfaceSteeringAuthorityError';
  }
}

function isOwnershipLeaseActive(session: OrchestratorSessionRecord): boolean {
  if (!session.lease_id) return false;
  const itemId = session.ownership_item_id ?? deriveMissionOwnershipItemId(session.mission_id);
  return listActiveWorkLeases().some(
    (lease) => lease.lease_id === session.lease_id && lease.item_id === itemId
  );
}

/**
 * Returns the active {@link OrchestratorSessionRecord} when
 * `(surface, channel, threadTs)` IS the current owner of `missionId` —
 * session active in the journal AND its mission-ownership lease still active
 * per a live work-coordination read (not just the journal projection).
 * Throws a typed {@link SurfaceSteeringAuthorityError} for every other case:
 *
 *  - `no_session_for_thread` — this thread has never had ANY orchestrator session.
 *  - `different_mission` — this thread's session (active or released) is for a different mission.
 *  - `session_released` — the thread's binding for THIS mission was already released.
 *  - `lease_expired` — the journal still shows `active`, but the cross-process
 *    ownership lease is gone (expired or reclaimed by another holder).
 *
 * Deliberately does NOT use `getSessionForThread` (SO-02): that helper only
 * ever returns `active` records, which would collapse "never had a session"
 * and "had one, released" into the same `null` — indistinguishable outcomes
 * this module's typed rejection needs to tell apart. Instead it looks up the
 * thread's session by its deterministic id across every status via
 * {@link listOrchestratorSessions}, mirroring how a session id is a stable
 * per-thread key that a later `createOrchestratorSession` call for a NEW
 * mission on the same thread overwrites in place.
 */
export function assertSurfaceSteeringAuthority(
  params: AssertSurfaceSteeringAuthorityParams
): OrchestratorSessionRecord {
  const sessionId = deriveSurfaceSessionId(params.surface, params.channel, params.threadTs);
  const session = listOrchestratorSessions().find((entry) => entry.session_id === sessionId);
  if (!session) {
    throw new SurfaceSteeringAuthorityError('no_session_for_thread', params);
  }
  const normalizedMissionId = normalizeOrchestratorMissionId(params.missionId);
  if (session.mission_id !== normalizedMissionId) {
    throw new SurfaceSteeringAuthorityError('different_mission', params, {
      sessionMissionId: session.mission_id,
    });
  }
  if (session.status !== 'active') {
    throw new SurfaceSteeringAuthorityError('session_released', params, {
      releaseReason: session.release_reason,
    });
  }
  if (!isOwnershipLeaseActive(session)) {
    throw new SurfaceSteeringAuthorityError('lease_expired', params, {
      leaseId: session.lease_id,
    });
  }
  return session;
}

/**
 * Japanese, UX-contract-valid rejection text for a
 * {@link SurfaceSteeringAuthorityError}. SO-04 surfaces this (or a
 * summarization built around it) as the conversational response when a
 * steering turn is refused for lack of owner authority. Every branch
 * includes a State signal (状態) and a concrete Next Action (次のアクション)
 * so it passes {@link validateSurfaceUxContract} unmodified.
 */
export function formatSteeringRejection(error: SurfaceSteeringAuthorityError): string {
  switch (error.caseId) {
    case 'no_session_for_thread':
      return (
        `状態: このスレッドはミッション ${error.params.missionId} のオーナーではありません` +
        '(オーケストレータセッション未作成)。\n' +
        '次のアクション: このスレッドからミッションを発行してオーナーになるか、' +
        '現在のオーナーのスレッドから操縦を依頼してください。'
      );
    case 'different_mission': {
      const ownerMissionId = String(error.detail.sessionMissionId ?? '不明');
      return (
        `状態: このスレッドは別のミッション(${ownerMissionId})のオーナーであり、` +
        `ミッション ${error.params.missionId} のオーナーではありません。\n` +
        '次のアクション: 対象ミッションのオーナースレッドから操縦するか、ハンドオフを依頼してください。'
      );
    }
    case 'session_released':
      return (
        '状態: このスレッドのオーケストレータセッションは解放済みです' +
        `(理由: ${String(error.detail.releaseReason ?? '不明')})。\n` +
        '次のアクション: 新しいオーケストレータセッションを作成してから操縦してください。'
      );
    case 'lease_expired':
      return (
        '状態: このスレッドの所有権リースが期限切れか、他プロセスに再取得されています。\n' +
        '次のアクション: セッションを再作成する、またはオーナー側でリースを更新してから再試行してください。'
      );
    default: {
      const exhaustiveCheck: never = error.caseId;
      return (
        `状態: このスレッドは現在ミッションを操縦できません(${String(exhaustiveCheck)})。\n` +
        '次のアクション: オーナー状況を確認のうえ、あらためて操作してください。'
      );
    }
  }
}

/**
 * Convenience check used by hermetic tests (and available to callers that
 * want to validate before surfacing a custom variant of the message):
 * whether {@link formatSteeringRejection}'s output for `error` passes
 * {@link validateSurfaceUxContract}.
 */
export function isSteeringRejectionUxValid(error: SurfaceSteeringAuthorityError): boolean {
  return validateSurfaceUxContract({ text: formatSteeringRejection(error) }).valid;
}
