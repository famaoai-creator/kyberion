/**
 * Content hash of a decision agenda (CD-05 version pinning, used by CD-01/02).
 *
 * The hash binds what the customer is shown — title, `from` (when set), phase,
 * locale, customer
 * and the entries (questions, options, impacts, layers, our decision, org
 * default, `requires_customer`, `override_until`). It deliberately excludes
 * the lifecycle fields (status, approval, revision, timestamps) and each
 * entry's `our_decision.decision_id`, which is pinned at approval time and so
 * cannot be part of what was approved.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../decision-ledger/model.js';
import type { AgendaEntry, DecisionAgenda } from './model.js';

export type AgendaHashInput = Pick<
  DecisionAgenda,
  'title' | 'phase' | 'locale' | 'customer' | 'entries'
> &
  Partial<Pick<DecisionAgenda, 'from'>>;

function hashableEntry(entry: AgendaEntry): AgendaEntry {
  if (!entry.our_decision) return entry;
  const { decision_id: _pinned, ...ourDecision } = entry.our_decision;
  void _pinned;
  return { ...entry, our_decision: ourDecision };
}

/** sha256 hex over the canonical JSON of the approved content. */
export function agendaContentHash(agenda: AgendaHashInput): string {
  const content = {
    title: agenda.title,
    // Only when set, so agendas without a sender keep their approved hash.
    ...(agenda.from !== undefined ? { from: agenda.from } : {}),
    phase: agenda.phase,
    locale: agenda.locale,
    customer: agenda.customer,
    entries: agenda.entries.map(hashableEntry),
  };
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}
