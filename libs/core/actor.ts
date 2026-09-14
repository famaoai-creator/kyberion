/**
 * FD-10 item 1: the one actor vocabulary (plan §2.5 principle 1).
 *
 * Before this module, "who did this" was recorded in at least four
 * incompatible shapes: `AuditEntry.agentId` (free string), approval
 * `decidedBy`/`decidedByRole`/`decidedByType`, deliverable-inbox
 * `reviewed_by`/`actor_id`/`actor_type`, and `DelegationLink.actor`
 * (`user:<id>` / nhi_id / legacy peer id, unvalidated). This module is the
 * one place that names an actor: every caller either builds an
 * {@link ActorRef} through {@link humanActor} / {@link agentActor} /
 * {@link serviceActor}, or converts an existing free-string label through
 * {@link actorFromLegacy}. Existing field names (`actor_id`, `requested_by`,
 * `approved_by`, `decided_by`, ...) stay as-is; they are aliases for this
 * vocabulary now, not a proliferation of new ones (plan §2.5 principle 1:
 * "新しい名前は増やさない").
 *
 * Kind grammar:
 *   - `human`  — id = `user:<member_id>` (`member-registry.ts` grammar).
 *   - `agent`  — id = a canonical `nhi_id` (`kyberion://agent/<org>/<slug>`,
 *     `agent-identity.ts` grammar).
 *   - `service` — id = `service:<slug>` (same slug grammar as nhi segments).
 *
 * Decision seams (approve / reject / accept / reject-with-reason) are
 * human-only (plan §2.5 principle 4): {@link assertHumanActor} is the one
 * check every such seam calls, so "who may decide" is answered by this
 * module instead of being re-implemented per call site.
 */

// Import the dependency-free grammar leaf modules directly (not
// `agent-identity.js` / `member-registry.js`): those modules pull in
// `authority.js` / `governed-catalog.js`, which transitively depend on
// `secure-io.js` — and `secure-io.js` depends on `audit-chain.js`, which
// depends on this module for its optional `actor` field. Importing the
// "rich" modules here would close that cycle back on itself at module-load
// time (surfaced as `TypeError: __name is not a function` deep inside
// `governed-catalog.ts`, a re-entrant-circular-import symptom).
import { parseNhiId } from './nhi-id.js';
import { isValidMemberId } from './member-id-grammar.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ActorKind = 'human' | 'agent' | 'service';

export interface ActorRef {
  kind: ActorKind;
  id: string;
  display_name?: string;
  /** For `kind: 'agent'` — the human actor id (`user:<member_id>`) this agent acted for. */
  on_behalf_of?: string;
}

export const HUMAN_ACTOR_PREFIX = 'user:';
export const SERVICE_ACTOR_PREFIX = 'service:';

/** Same slug grammar as an nhi_id segment (`agent-identity.ts` NHI_SLUG_PATTERN). */
const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export class ActorFormatError extends Error {
  constructor(message: string) {
    super(`[actor] ${message}`);
    this.name = 'ActorFormatError';
  }
}

export class ActorAccountabilityError extends Error {
  constructor(operation: string, actor: ActorRef | undefined) {
    super(
      `[actor] '${operation}' requires a human actor (kind='human'); got ` +
        (actor ? `kind='${actor.kind}' id='${actor.id}'` : 'no actor')
    );
    this.name = 'ActorAccountabilityError';
  }
}

// ---------------------------------------------------------------------------
// Constructors — throw ActorFormatError on invalid grammar
// ---------------------------------------------------------------------------

function trimmedOrThrow(value: string, label: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new ActorFormatError(`${label} must be a non-empty string`);
  return trimmed;
}

/** `id = user:<member_id>` — validated against the member-registry id grammar. */
export function humanActor(memberId: string, displayName?: string): ActorRef {
  const trimmed = trimmedOrThrow(memberId, 'member id');
  if (!isValidMemberId(trimmed)) {
    throw new ActorFormatError(`invalid member id "${memberId}" for a human actor`);
  }
  return {
    kind: 'human',
    id: `${HUMAN_ACTOR_PREFIX}${trimmed}`,
    ...(displayName?.trim() ? { display_name: displayName.trim() } : {}),
  };
}

/** `id` = a canonical nhi_id (`kyberion://agent/<org>/<slug>`). */
export function agentActor(nhiId: string, onBehalfOf?: string): ActorRef {
  const trimmed = trimmedOrThrow(nhiId, 'nhi_id');
  if (!parseNhiId(trimmed)) {
    throw new ActorFormatError(`invalid nhi_id "${nhiId}" for an agent actor`);
  }
  const behalf = onBehalfOf?.trim();
  if (behalf) {
    const human = parseActorRef({ kind: 'human', id: behalf });
    if (!human) {
      throw new ActorFormatError(`invalid on_behalf_of "${onBehalfOf}" for an agent actor`);
    }
  }
  return {
    kind: 'agent',
    id: trimmed,
    ...(behalf ? { on_behalf_of: behalf } : {}),
  };
}

/** `id = service:<slug>`. Accepts either a bare slug or an already-prefixed id. */
export function serviceActor(id: string): ActorRef {
  const trimmed = trimmedOrThrow(id, 'service id');
  const slug = trimmed.startsWith(SERVICE_ACTOR_PREFIX)
    ? trimmed.slice(SERVICE_ACTOR_PREFIX.length)
    : trimmed;
  if (!SERVICE_SLUG_PATTERN.test(slug)) {
    throw new ActorFormatError(
      `invalid service id "${id}" (slug must match ${SERVICE_SLUG_PATTERN})`
    );
  }
  return { kind: 'service', id: `${SERVICE_ACTOR_PREFIX}${slug}` };
}

// ---------------------------------------------------------------------------
// Parsing — never throws
// ---------------------------------------------------------------------------

function isActorKind(value: unknown): value is ActorKind {
  return value === 'human' || value === 'agent' || value === 'service';
}

/**
 * Strict, additive-tolerant parse of a persisted/transmitted actor value:
 * unknown extra properties are dropped (forward compatible with future
 * fields), but `kind`/`id` must be present and mutually consistent with the
 * grammar for that kind. Returns `null` for anything else — this function
 * never throws, so a caller reading untrusted/legacy data can always fall
 * back safely.
 */
export function parseActorRef(value: unknown): ActorRef | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const id = record.id;
  if (!isActorKind(kind) || typeof id !== 'string') return null;
  const trimmedId = id.trim();
  if (!trimmedId) return null;

  if (kind === 'human') {
    if (!trimmedId.startsWith(HUMAN_ACTOR_PREFIX)) return null;
    if (!isValidMemberId(trimmedId.slice(HUMAN_ACTOR_PREFIX.length))) return null;
  } else if (kind === 'agent') {
    if (!parseNhiId(trimmedId)) return null;
  } else {
    if (!trimmedId.startsWith(SERVICE_ACTOR_PREFIX)) return null;
    if (!SERVICE_SLUG_PATTERN.test(trimmedId.slice(SERVICE_ACTOR_PREFIX.length))) return null;
  }

  const displayName = record.display_name;
  const onBehalfOf = record.on_behalf_of;
  return {
    kind,
    id: trimmedId,
    ...(typeof displayName === 'string' && displayName.trim()
      ? { display_name: displayName.trim() }
      : {}),
    ...(typeof onBehalfOf === 'string' && onBehalfOf.trim()
      ? { on_behalf_of: onBehalfOf.trim() }
      : {}),
  };
}

export function actorId(actor: ActorRef): string {
  return actor.id;
}

/**
 * Decision seams (approve/reject/accept/reject-with-reason) are human-only
 * (plan §2.5 principle 4). Call this at every such seam instead of
 * re-implementing the check.
 */
export function assertHumanActor(
  actor: ActorRef | undefined,
  operation: string
): asserts actor is ActorRef & { kind: 'human' } {
  if (!actor || actor.kind !== 'human') {
    throw new ActorAccountabilityError(operation, actor);
  }
}

/**
 * Best-effort conversion of an existing free-string actor label into the
 * vocabulary, for callers that only ever carried a string (`agentId`,
 * `decidedBy`, `actorPeerId`, ...). Never throws and never rejects a legacy
 * value — this is for audit/reporting projection, not for authorization.
 *
 * `human:operator` and other synthetic legacy labels are deliberately mapped
 * to `kind: 'service'`, never `kind: 'human'`: they were never a verified
 * person, so treating them as human would let a `human:*`-named actor pass
 * {@link assertHumanActor} without ever having gone through
 * {@link humanActor}'s member-id grammar check.
 */
export function actorFromLegacy(value: string | undefined): ActorRef | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  if (trimmed.startsWith(HUMAN_ACTOR_PREFIX)) {
    return (
      parseActorRef({ kind: 'human', id: trimmed }) ?? {
        kind: 'service',
        id: trimmed,
      }
    );
  }
  if (parseNhiId(trimmed)) {
    return { kind: 'agent', id: trimmed };
  }
  return { kind: 'service', id: trimmed };
}
