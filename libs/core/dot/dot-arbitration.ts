/**
 * Dot arbitration (DL-11) — cross-dot conflict detection before the gate.
 *
 * Pre-gate check `dot-arbitration`: a proposal with a `target` conflicts with
 * another dot's action from the last {@link DOT_ARBITRATION_WINDOW_MS} that is
 * still live — parked on the operator, or dispatched with its WorkItem open —
 * when the targets are equal or glob-overlap (`path:<glob>`) and the intents
 * oppose (create/remove, enable/disable, increase/decrease, apply/revert,
 * merge/close) or both mutate. Proposals without a target never conflict, and
 * only dots in the same tenant scope are ever compared.
 *
 * Resolution, per conflict:
 *   1. sole owner (a `team.owns` pattern covers a contested target) wins;
 *   2. else a `team.priority` difference ≥ {@link DOT_ARBITRATION_PRIORITY_GAP}
 *      wins (default priority 50);
 *   3. else nobody wins.
 * A losing newcomer is refused. Otherwise the newcomer is escalated as ONE
 * decision card (floor `approve`) that lists both proposals and links the
 * older action it would supersede.
 *
 * Settlement (supervisor step `dot-arbitration-settle`, after housekeeping
 * settled the newcomer's card): approved → the older action is declined as
 * `superseded` (no feedback, so no learned-floor raise) or its open WorkItem
 * is blocked; rejected → the newcomer stays declined and the older continues.
 *
 * Ledger: `dotStatePath(newcomer, 'arbitration.jsonl')` — tenant-scoped for
 * tenant dots, so another tenant's titles never land in a shared file.
 *
 * Registry note: dot-extension-registry imports this module and dot-dispatch
 * imports the registry, so the registration is the hoisted function
 * {@link dotArbitrationPreGateCheck} (no module-level value read during the cycle).
 */

import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { getWorkItem, updateWorkItem } from '../workforce/work-coordination.js';
import type { UpdateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import { listDotCharters, type DotCharter } from './dot-charter.js';
import {
  currentDotActions,
  dotActorId,
  dotProposalHash,
  latestDotActions,
  supersedeDotParkedAction,
  type DotActionRecord,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import type { DotExtCtx, DotPreGateCheck } from './dot-extensions.js';
import type { DotProposal, DotProposalIntent } from './dot-proposals.js';
import { DOT_ARBITRATION_FILE, dotStatePath, type DotArbitrationRow } from './dot-state-paths.js';

const logger = createLogger('dot-arbitration');

export const DOT_ARBITRATION_CHECK_ID = 'dot-arbitration';
export const DOT_ARBITRATION_SETTLE_STEP_ID = 'dot-arbitration-settle';
/** Only actions this recent are arbitrated against. */
export const DOT_ARBITRATION_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Priority difference that decides a conflict without the operator. */
export const DOT_ARBITRATION_PRIORITY_GAP = 10;
export const DEFAULT_DOT_ARBITRATION_PRIORITY = 50;

const OPPOSING_INTENTS: ReadonlyArray<readonly [DotProposalIntent, DotProposalIntent]> = [
  ['create', 'remove'],
  ['enable', 'disable'],
  ['increase', 'decrease'],
  ['apply', 'revert'],
  ['merge', 'close'],
];
/**
 * A dispatched action conflicts only while its WorkItem can still change
 * something; a blocked item (e.g. one already superseded) does not.
 */
const LIVE_WORK_ITEM_STATUSES: readonly string[] = ['backlog', 'ready', 'in_progress', 'review'];

export interface DotArbitrationDeps {
  rootDir?: string;
  /** Every known charter (any status) — the other dot's tenant, owns and priority come from here. */
  listCharters?: () => DotCharter[];
  getWorkItem?: (itemId: string) => WorkItem | null;
  updateWorkItem?: (input: UpdateWorkItemInput) => WorkItem;
  /** Passed to dot-dispatch when superseding a parked action (approval store seams). */
  dispatch?: Omit<DotDispatchDeps, 'rootDir' | 'now'>;
}

// ---------------------------------------------------------------------------
// target / intent matching
// ---------------------------------------------------------------------------

function splitTarget(target: string): { kind: string; value: string } {
  const index = target.indexOf(':');
  return index < 0
    ? { kind: '', value: target }
    : { kind: target.slice(0, index), value: target.slice(index + 1) };
}

const GLOB_CHARS = /[*?[{]/;

/** `**` crosses segments, `*` / `?` stay within one; everything else is literal. */
function globRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function literalPrefix(glob: string): string {
  const match = GLOB_CHARS.exec(glob);
  return match ? glob.slice(0, match.index) : glob;
}

/**
 * Equal targets overlap; `path:` globs overlap when either matches the other
 * or (both wildcarded) their literal prefixes nest — a deliberate
 * over-approximation, since a false conflict only costs an operator decision.
 */
export function dotTargetsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const left = splitTarget(a);
  const right = splitTarget(b);
  if (left.kind !== right.kind || left.kind !== 'path') return false;
  const leftGlob = GLOB_CHARS.test(left.value);
  const rightGlob = GLOB_CHARS.test(right.value);
  if (leftGlob && globRegExp(left.value).test(right.value)) return true;
  if (rightGlob && globRegExp(right.value).test(left.value)) return true;
  if (leftGlob && rightGlob) {
    const lp = literalPrefix(left.value);
    const rp = literalPrefix(right.value);
    return lp.startsWith(rp) || rp.startsWith(lp);
  }
  return false;
}

/** True when an owns pattern (same `kind:` form, glob value) covers the target. */
export function dotOwnsTarget(charter: DotCharter, target: string): boolean {
  const wanted = splitTarget(target);
  return (charter.team?.owns ?? []).some((pattern) => {
    if (pattern === target) return true;
    const owned = splitTarget(pattern);
    return owned.kind === wanted.kind && globRegExp(owned.value).test(wanted.value);
  });
}

/**
 * Every intent mutates its target; a target without an intent is treated as an
 * `update` (mutating) rather than assumed harmless.
 */
export function dotIntentsConflict(
  a: DotProposalIntent | undefined,
  b: DotProposalIntent | undefined
): 'opposing' | 'both_mutating' {
  if (a && b && OPPOSING_INTENTS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) {
    return 'opposing';
  }
  return 'both_mutating';
}

function dotPriority(charter: DotCharter): number {
  return charter.team?.priority ?? DEFAULT_DOT_ARBITRATION_PRIORITY;
}

/** Same tenant scope: both untenanted, or the same tenant slug. */
function sameTenantScope(a: DotCharter, b: DotCharter): boolean {
  return (a.scope.tenant_slug ?? '') === (b.scope.tenant_slug ?? '');
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

function arbitrationFile(charter: DotCharter, rootDir: string | undefined): string {
  return path.join(rootDir ?? pathResolver.rootDir(), dotStatePath(charter, DOT_ARBITRATION_FILE));
}

export function readDotArbitrationRows(
  charter: DotCharter,
  deps: { rootDir?: string } = {}
): DotArbitrationRow[] {
  return readJsonLines<DotArbitrationRow>(arbitrationFile(charter, deps.rootDir), {
    onMalformed: 'skip',
  }).filter((row) => row?.dot_id === charter.dot_id && typeof row.resolution === 'string');
}

function appendArbitrationRow(
  charter: DotCharter,
  row: DotArbitrationRow,
  rootDir: string | undefined
): void {
  const file = arbitrationFile(charter, rootDir);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, row);
}

// ---------------------------------------------------------------------------
// pre-gate check
// ---------------------------------------------------------------------------

interface DotConflict {
  other: DotCharter;
  action: DotActionRecord;
  kind: 'opposing' | 'both_mutating';
}

function charterList(deps: DotArbitrationDeps, rootDir: string | undefined): DotCharter[] {
  return (
    deps.listCharters?.() ??
    listDotCharters(rootDir, { errors: [] }).map((loaded) => loaded.charter)
  );
}

function workItemLive(
  action: DotActionRecord,
  deps: DotArbitrationDeps,
  rootDir?: string
): boolean {
  if (!action.work_item_id) return false;
  const item = (deps.getWorkItem ?? ((id: string) => getWorkItem(id, rootDir ? { rootDir } : {})))(
    action.work_item_id
  );
  return Boolean(item && LIVE_WORK_ITEM_STATUSES.includes(item.status));
}

/** Live actions of OTHER dots in the same tenant scope that conflict with the proposal. */
export function dotArbitrationConflicts(
  charter: DotCharter,
  proposal: DotProposal,
  ctx: DotExtCtx,
  deps: DotArbitrationDeps = {}
): DotConflict[] {
  const target = proposal.target;
  if (!target) return [];
  const rootDir = deps.rootDir ?? ctx.rootDir;
  const nowMs = ctx.now().getTime();
  const candidates = latestDotActions({ rootDir }).filter(
    (row) =>
      row.dot_id !== charter.dot_id &&
      typeof row.target === 'string' &&
      (row.status === 'parked' || row.status === 'dispatched') &&
      nowMs - Date.parse(row.at) < DOT_ARBITRATION_WINDOW_MS &&
      dotTargetsOverlap(target, row.target)
  );
  if (candidates.length === 0) return [];
  const charters = new Map(charterList(deps, rootDir).map((other) => [other.dot_id, other]));
  const conflicts: DotConflict[] = [];
  for (const action of candidates) {
    const other = charters.get(action.dot_id);
    // Unknown charter → tenant scope cannot be verified → never compared.
    if (!other || !sameTenantScope(charter, other)) continue;
    if (action.status === 'dispatched' && !workItemLive(action, deps, rootDir)) continue;
    conflicts.push({ other, action, kind: dotIntentsConflict(proposal.intent, action.intent) });
  }
  return conflicts;
}

function describe(dotId: string, title: string, intent?: string, target?: string): string {
  return `${dotActorId(dotId)} "${title}" (${intent ?? 'update'} ${target ?? '?'})`;
}

type Winner = { side: 'newcomer' | 'older' | 'none'; by: 'owner' | 'priority' | 'none' };

function decideWinner(charter: DotCharter, proposal: DotProposal, conflict: DotConflict): Winner {
  const contested = [proposal.target, conflict.action.target].filter(
    (value): value is string => typeof value === 'string'
  );
  const newcomerOwns = contested.some((target) => dotOwnsTarget(charter, target));
  const olderOwns = contested.some((target) => dotOwnsTarget(conflict.other, target));
  if (newcomerOwns !== olderOwns) {
    return { side: newcomerOwns ? 'newcomer' : 'older', by: 'owner' };
  }
  const gap = dotPriority(charter) - dotPriority(conflict.other);
  if (Math.abs(gap) >= DOT_ARBITRATION_PRIORITY_GAP) {
    return { side: gap > 0 ? 'newcomer' : 'older', by: 'priority' };
  }
  return { side: 'none', by: 'none' };
}

/** The `dot-arbitration` verdict for one proposal; writes one ledger row per refusal / escalation. */
export function checkDotArbitration(
  charter: DotCharter,
  proposal: DotProposal,
  ctx: DotExtCtx,
  deps: DotArbitrationDeps = {}
): ReturnType<DotPreGateCheck['check']> {
  const conflicts = dotArbitrationConflicts(charter, proposal, ctx, deps);
  if (conflicts.length === 0) return { ok: true };
  const rootDir = deps.rootDir ?? ctx.rootDir;
  const at = ctx.now().toISOString();
  const hash = dotProposalHash(charter.dot_id, proposal);
  const rowBase = {
    at,
    dot_id: charter.dot_id,
    proposal_hash: hash,
    ...(proposal.target ? { target: proposal.target } : {}),
    ...(proposal.intent ? { intent: proposal.intent } : {}),
  };
  const escalated: Array<{ conflict: DotConflict; winner: Winner }> = [];
  for (const conflict of conflicts) {
    const winner = decideWinner(charter, proposal, conflict);
    const ref = { dot_id: conflict.other.dot_id, action_ref: conflict.action.action_ref };
    if (winner.side === 'older') {
      const reason =
        winner.by === 'owner'
          ? `target owned by ${dotActorId(conflict.other.dot_id)} (conflicts with ${conflict.action.action_ref})`
          : `${dotActorId(conflict.other.dot_id)} has higher priority (${dotPriority(conflict.other)} vs ${dotPriority(charter)}) on a conflicting action ${conflict.action.action_ref}`;
      appendArbitrationRow(
        charter,
        {
          ...rowBase,
          conflicts_with: ref,
          resolution: winner.by === 'owner' ? 'defer_to_owner' : 'defer_to_priority',
          reason,
        },
        rootDir
      );
      return { ok: false, reason };
    }
    escalated.push({ conflict, winner });
  }
  // One card for the whole proposal; it supersedes the first (most recent) conflict.
  const ordered = [...escalated].sort(
    (a, b) => Date.parse(b.conflict.action.at) - Date.parse(a.conflict.action.at)
  );
  const primary = ordered[0].conflict;
  const link = { action_ref: primary.action.action_ref, dot_id: primary.other.dot_id };
  const lines = [
    `Cross-dot conflict (${DOT_ARBITRATION_CHECK_ID}):`,
    `- this proposal: ${describe(charter.dot_id, proposal.title, proposal.intent, proposal.target)}, priority ${dotPriority(charter)}`,
    ...ordered.map(
      ({ conflict, winner }) =>
        `- conflicts with: ${describe(conflict.other.dot_id, conflict.action.title, conflict.action.intent, conflict.action.target)} — ${conflict.action.status} ${conflict.action.action_ref}, priority ${dotPriority(conflict.other)}; ${conflict.kind === 'opposing' ? 'opposing intents' : 'both mutate the target'}${winner.side === 'newcomer' ? `; this dot wins by ${winner.by}` : ''}`
    ),
    `Approve → this proposal proceeds and supersedes ${link.action_ref} (declined as superseded, or its open WorkItem blocked). Reject → this proposal is declined and ${dotActorId(link.dot_id)} continues.`,
  ];
  const reason = `conflicts with ${dotActorId(link.dot_id)} action ${link.action_ref}; operator decides`;
  for (const { conflict, winner } of ordered) {
    appendArbitrationRow(
      charter,
      {
        ...rowBase,
        conflicts_with: { dot_id: conflict.other.dot_id, action_ref: conflict.action.action_ref },
        resolution: 'escalated',
        floor: 'approve',
        reason:
          winner.side === 'newcomer'
            ? `wins by ${winner.by}; superseding needs the operator`
            : `no sole owner, priority gap < ${DOT_ARBITRATION_PRIORITY_GAP}`,
      },
      rootDir
    );
  }
  return { ok: 'escalate', reason, card_context: lines.join('\n'), link };
}

/** Registry entry. A hoisted function so the registry ↔ dispatch import cycle never reads it early. */
export function dotArbitrationPreGateCheck(deps: DotArbitrationDeps = {}): DotPreGateCheck {
  return {
    id: 'dot-arbitration',
    check: (charter, proposal, ctx) => checkDotArbitration(charter, proposal, ctx, deps),
  };
}

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

export interface DotArbitrationSettlement {
  dot_id: string;
  action_ref: string;
  resolution: 'superseded' | 'declined';
  older: { dot_id: string; action_ref: string };
  effect: 'declined_parked' | 'blocked_work_item' | 'none';
}

function blockLiveWorkItem(
  older: DotActionRecord,
  supersededBy: { dot_id: string; action_ref: string },
  deps: DotArbitrationDeps,
  rootDir: string | undefined
): boolean {
  if (!older.work_item_id) return false;
  const item = (deps.getWorkItem ?? ((id: string) => getWorkItem(id, rootDir ? { rootDir } : {})))(
    older.work_item_id
  );
  if (!item || !LIVE_WORK_ITEM_STATUSES.includes(item.status)) return false;
  (deps.updateWorkItem ?? updateWorkItem)({
    itemId: item.item_id,
    status: 'blocked',
    metadata: {
      ...(item.metadata ?? {}),
      blocked_reason: `superseded by ${dotActorId(supersededBy.dot_id)} action ${supersededBy.action_ref}`,
      superseded_by: supersededBy,
    },
    ...(rootDir ? { rootDir } : {}),
  });
  return true;
}

/**
 * Apply the operator's answer to each settled arbitration card of `charter`
 * (the newcomer). Idempotent: an action_ref with a settlement row is skipped.
 */
export function settleDotArbitration(
  charter: DotCharter,
  now: Date,
  deps: DotArbitrationDeps = {}
): DotArbitrationSettlement[] {
  const rootDir = deps.rootDir;
  const dispatchDeps: DotDispatchDeps = { ...(deps.dispatch ?? {}), rootDir, now: () => now };
  const done = new Set(
    readDotArbitrationRows(charter, { rootDir })
      .filter((row) => row.resolution === 'superseded' || row.resolution === 'declined')
      .map((row) => row.action_ref)
  );
  const settlements: DotArbitrationSettlement[] = [];
  let charters: Map<string, DotCharter> | undefined;
  for (const row of currentDotActions(charter.dot_id, dispatchDeps)) {
    const link = row.escalation?.link;
    if (!link || done.has(row.action_ref)) continue;
    if (row.status !== 'dispatched' && row.status !== 'declined') continue;
    const base = {
      at: now.toISOString(),
      dot_id: charter.dot_id,
      proposal_hash: row.proposal_hash,
      action_ref: row.action_ref,
      conflicts_with: link,
      ...(row.target ? { target: row.target } : {}),
      ...(row.intent ? { intent: row.intent } : {}),
    };
    if (row.status === 'declined') {
      appendArbitrationRow(
        charter,
        {
          ...base,
          resolution: 'declined',
          reason: `newcomer declined (${row.reason ?? 'n/a'}); ${link.action_ref} continues`,
        },
        rootDir
      );
      settlements.push({
        dot_id: charter.dot_id,
        action_ref: row.action_ref,
        resolution: 'declined',
        older: link,
        effect: 'none',
      });
      continue;
    }
    charters ??= new Map(charterList(deps, rootDir).map((other) => [other.dot_id, other]));
    const other = charters.get(link.dot_id);
    let effect: DotArbitrationSettlement['effect'] = 'none';
    if (other && sameTenantScope(charter, other)) {
      const supersededBy = { dot_id: charter.dot_id, action_ref: row.action_ref };
      const older = currentDotActions(other.dot_id, dispatchDeps).find(
        (candidate) => candidate.action_ref === link.action_ref
      );
      if (older?.status === 'parked') {
        if (supersedeDotParkedAction(other, older.action_ref, supersededBy, dispatchDeps)) {
          effect = 'declined_parked';
        }
      } else if (older?.status === 'dispatched') {
        try {
          if (blockLiveWorkItem(older, supersededBy, deps, rootDir)) effect = 'blocked_work_item';
        } catch (error) {
          logger.warn(
            `could not block WorkItem ${older.work_item_id} superseded by ${row.action_ref} — ${error instanceof Error ? error.message : String(error)} | next: retried on the next sweep | evidence: ${dotStatePath(charter, DOT_ARBITRATION_FILE)}`
          );
          continue;
        }
      }
    } else {
      logger.warn(
        `arbitration link ${link.action_ref} of ${row.action_ref} has no same-tenant charter (${link.dot_id}) — nothing superseded | next: none; recorded once | evidence: ${dotStatePath(charter, DOT_ARBITRATION_FILE)}`
      );
    }
    appendArbitrationRow(
      charter,
      {
        ...base,
        resolution: 'superseded',
        reason:
          effect === 'declined_parked'
            ? `approved; ${link.action_ref} declined as superseded`
            : effect === 'blocked_work_item'
              ? `approved; WorkItem of ${link.action_ref} blocked`
              : `approved; ${link.action_ref} was no longer live`,
      },
      rootDir
    );
    settlements.push({
      dot_id: charter.dot_id,
      action_ref: row.action_ref,
      resolution: 'superseded',
      older: link,
      effect,
    });
  }
  return settlements;
}
