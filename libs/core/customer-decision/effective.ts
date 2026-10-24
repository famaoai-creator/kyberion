/**
 * Effective decision resolution (CD-02). Pure functions — callers pass `now`.
 *
 * Layers (default order customer > ours > org_default):
 *   - customer:    the ACTIVE ledger record for the entry's item × key with
 *                  `level: customer-value`, `state: decided` and a customer
 *                  actor in `decided_by.on_behalf_of` → `confirmed`;
 *   - ours:        the most recent ledger record (active or superseded) for
 *                  the item × key whose id is pinned in an approved agenda
 *                  revision → `provisional`. A proposed record that is not
 *                  pinned (a conversation answer, a draft) is never "ours";
 *   - org_default: the value the agenda entry carries (hearing-sheet template)
 *                  → `provisional`. It is never written to the ledger.
 *
 * The first layer in the entry's order that has a candidate wins. An entry
 * with `requires_customer: true` only listens to the customer layer; until the
 * customer decides it is `awaiting_customer` and work that needs it waits.
 *
 * Switches are detected by comparing two resolutions; freshness compares what a
 * task consumed at its start against the current resolution at its end
 * (task-boundary reconciliation — running tasks are never interrupted).
 */
import { canonicalJson, type DecisionRecord } from '../decision-ledger/model.js';
import { agendaContentHash } from './hash.js';
import {
  entryLayers,
  type AgendaEntry,
  type ConsumedDecisionLock,
  type DecisionAgenda,
  type DecisionLayerName,
  type DecisionSwitch,
  type EffectiveDecision,
} from './model.js';

export interface ResolveEffectiveOptions {
  /** Ids of our decisions pinned in an approved agenda revision. */
  approvedOurDecisionIds: ReadonlySet<string>;
  now: string;
  milestonesPassed?: readonly string[];
}

interface LayerCandidate {
  layer: DecisionLayerName;
  value: unknown;
  decision_id?: string;
  decided_by?: string;
  at?: string;
}

/** Value identity that tells `undefined` (no value) apart from every JSON value, `null` included. */
function valueKey(value: unknown): string {
  return value === undefined ? '\u0000undefined' : canonicalJson(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return valueKey(a) === valueKey(b);
}

/** Is the entry's override window (`override_until`) still open at `now`? */
export function isOverrideWindowOpen(
  entry: Pick<AgendaEntry, 'override_until'>,
  now: string,
  milestonesPassed: readonly string[] = []
): boolean {
  const until = entry.override_until;
  if (!until) return true;
  if (until.kind === 'date') {
    const deadline = Date.parse(until.at);
    const current = Date.parse(now);
    if (Number.isNaN(deadline) || Number.isNaN(current)) return false;
    return current < deadline;
  }
  return !milestonesPassed.includes(until.milestone);
}

function customerCandidate(
  entry: AgendaEntry,
  ledger: readonly DecisionRecord[]
): LayerCandidate | undefined {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const record = ledger[index];
    if (record.item !== entry.item || record.key !== entry.key) continue;
    if (record.status !== 'active') continue;
    if (record.level !== 'customer-value' || record.state !== 'decided') continue;
    const onBehalfOf = record.decided_by?.on_behalf_of?.actor_id;
    if (!onBehalfOf) continue;
    return {
      layer: 'customer',
      value: record.value,
      decision_id: record.id,
      decided_by: onBehalfOf,
      ...(record.decided_at ? { at: record.decided_at } : {}),
    };
  }
  return undefined;
}

function oursCandidate(
  entry: AgendaEntry,
  ledger: readonly DecisionRecord[],
  approved: ReadonlySet<string>
): LayerCandidate | undefined {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const record = ledger[index];
    if (record.item !== entry.item || record.key !== entry.key) continue;
    if (!approved.has(record.id)) continue;
    const by = record.decided_by?.id ?? record.proposed_by?.id;
    const at = record.decided_at ?? record.proposed_at;
    return {
      layer: 'ours',
      value: record.value,
      decision_id: record.id,
      ...(by ? { decided_by: by } : {}),
      ...(at ? { at } : {}),
    };
  }
  return undefined;
}

function orgDefaultCandidate(entry: AgendaEntry): LayerCandidate | undefined {
  if (!entry.org_default) return undefined;
  return {
    layer: 'org_default',
    value: entry.org_default.value,
    decided_by: entry.org_default.source,
  };
}

/** Resolve the decision work follows for one agenda entry. */
export function resolveEffectiveDecision(
  entry: AgendaEntry,
  ledger: readonly DecisionRecord[],
  opts: ResolveEffectiveOptions
): EffectiveDecision {
  const base = {
    entry_id: entry.entry_id,
    item: entry.item,
    key: entry.key,
    overridable: isOverrideWindowOpen(entry, opts.now, opts.milestonesPassed),
  };
  const layers: readonly DecisionLayerName[] = entry.requires_customer
    ? ['customer']
    : entryLayers(entry);
  for (const layer of layers) {
    const candidate =
      layer === 'customer'
        ? customerCandidate(entry, ledger)
        : layer === 'ours'
          ? oursCandidate(entry, ledger, opts.approvedOurDecisionIds)
          : orgDefaultCandidate(entry);
    if (!candidate) continue;
    return {
      ...base,
      layer: candidate.layer,
      value: candidate.value,
      ...(candidate.decision_id ? { decision_id: candidate.decision_id } : {}),
      status: candidate.layer === 'customer' ? 'confirmed' : 'provisional',
      ...(candidate.decided_by ? { decided_by: candidate.decided_by } : {}),
      ...(candidate.at ? { at: candidate.at } : {}),
    };
  }
  return {
    ...base,
    layer: 'none',
    status: entry.requires_customer ? 'awaiting_customer' : 'undecided',
  };
}

/**
 * Our decision ids in force for an agenda:
 *   - approved and unchanged since (approval hash = current content): the pins
 *     of that approval (each entry's `our_decision.decision_id`);
 *   - otherwise (edited after approval, not re-approved yet): the pins of the
 *     last approval (`in_force`) — those ledger records were approved; the
 *     unapproved edit itself is not in force;
 *   - never approved: nothing.
 */
export function approvedOurDecisionIds(agenda: DecisionAgenda): Set<string> {
  const ids = new Set<string>();
  if (agenda.approval && agenda.approval.content_hash === agendaContentHash(agenda)) {
    for (const entry of agenda.entries) {
      const id = entry.our_decision?.decision_id;
      if (id) ids.add(id);
    }
    return ids;
  }
  for (const id of agenda.in_force?.pinned_ids ?? []) ids.add(id);
  return ids;
}

/** Resolve every entry of an agenda. Milestones default to the agenda's `milestones_passed`. */
export function resolveAgendaEffective(
  agenda: DecisionAgenda,
  ledger: readonly DecisionRecord[],
  opts: { now: string; milestonesPassed?: readonly string[] }
): EffectiveDecision[] {
  const approved = approvedOurDecisionIds(agenda);
  const milestonesPassed = opts.milestonesPassed ?? agenda.milestones_passed ?? [];
  return agenda.entries.map((entry) =>
    resolveEffectiveDecision(entry, ledger, {
      approvedOurDecisionIds: approved,
      now: opts.now,
      milestonesPassed,
    })
  );
}

function switchSide(decision: EffectiveDecision | undefined): DecisionSwitch['from'] {
  if (!decision || decision.layer === 'none') return { layer: 'none' };
  return {
    layer: decision.layer,
    ...(decision.value !== undefined ? { value: decision.value } : {}),
    ...(decision.decision_id ? { decision_id: decision.decision_id } : {}),
  };
}

/**
 * Switch events between two resolutions of the same agenda:
 *   - `value_changed` when the effective value differs (an entry absent from
 *     `before` counts as having no value);
 *   - `confirmed` when the value is equal but the status moved provisional → confirmed
 *     (the customer kept our decision).
 * Nothing else is a switch.
 */
export function detectSwitches(
  before: readonly EffectiveDecision[],
  after: readonly EffectiveDecision[],
  ctx: {
    case_id: string;
    agenda_id: string;
    now: string;
    cause_receipt_id?: string;
    newId: () => string;
  }
): DecisionSwitch[] {
  const previous = new Map(before.map((decision) => [decision.entry_id, decision]));
  const switches: DecisionSwitch[] = [];
  for (const current of after) {
    const prior = previous.get(current.entry_id);
    let kind: DecisionSwitch['kind'] | undefined;
    if (!sameValue(prior?.value, current.value)) kind = 'value_changed';
    else if (prior?.status === 'provisional' && current.status === 'confirmed') kind = 'confirmed';
    if (!kind) continue;
    switches.push({
      version: '1.0.0',
      switch_id: ctx.newId(),
      case_id: ctx.case_id,
      agenda_id: ctx.agenda_id,
      entry_id: current.entry_id,
      item: current.item,
      key: current.key,
      kind,
      from: switchSide(prior),
      to: switchSide(current),
      at: ctx.now,
      ...(ctx.cause_receipt_id ? { cause_receipt_id: ctx.cause_receipt_id } : {}),
    });
  }
  return switches;
}

export interface DecisionFreshnessResult {
  fresh: boolean;
  stale: Array<{
    item: string;
    key: string;
    locked: ConsumedDecisionLock['decisions'][number];
    current: EffectiveDecision | undefined;
  }>;
}

/**
 * Task-boundary reconciliation: is what the task consumed still the effective
 * value? Only the value counts — the same value from a different layer is fresh.
 */
export function checkDecisionFreshness(
  lock: ConsumedDecisionLock,
  current: readonly EffectiveDecision[]
): DecisionFreshnessResult {
  const stale: DecisionFreshnessResult['stale'] = [];
  for (const locked of lock.decisions) {
    const now = current.find(
      (decision) => decision.item === locked.item && decision.key === locked.key
    );
    if (!now || !sameValue(locked.value, now.value)) {
      stale.push({ item: locked.item, key: locked.key, locked, current: now });
    }
  }
  return { fresh: stale.length === 0, stale };
}

export type LayerPrecedenceResult =
  { ok: true } | { ok: false; reason: 'customer_decision_locked' | 'override_window_closed' };

/**
 * May a decision from `incoming` replace the current effective decision?
 *   - ours / org_default never replace a customer decision;
 *   - a customer decision replaces anything while the override window is open;
 *     after it closes the facade turns the change into a change request.
 *     Where nothing is in force yet (`layer: 'none'`), there is nothing to override.
 */
export function checkLayerPrecedence(
  current: EffectiveDecision,
  incoming: DecisionLayerName
): LayerPrecedenceResult {
  if (incoming !== 'customer') {
    return current.layer === 'customer'
      ? { ok: false, reason: 'customer_decision_locked' }
      : { ok: true };
  }
  if (current.layer === 'none' || current.overridable) return { ok: true };
  return { ok: false, reason: 'override_window_closed' };
}
