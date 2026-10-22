/**
 * Decision ledger — the code name of SSOD, Single Source of Decisions (SD-00, plan
 * docs/developer/improvement-plans-2026-09/SSOD_HEARING_INTEGRATION_PLAN_2026-09-14.ja.md §2).
 *
 * The one vocabulary for "a decision" across the hearing surface, the
 * governed `pnpm decisions` facade, and the per-tenant decision ledger. Nothing in
 * this module touches disk: it is the type + constant layer the pure
 * modules (`promote.ts`, `conformance.ts`, `hearing-scenario.ts`,
 * `product-concept.ts`) and the I/O module (`ledger.ts`) share.
 *
 * Shape rationale (validated in the tenant-side PoC before it was ported):
 *   - a decision is *about* one canonical item (`item`, e.g. a screen field id)
 *     and one aspect of it (`key`, e.g. `csv.columns`); the pair is unique
 *     among `status: 'active'` records, so a later decision on the same pair
 *     must name what it `supersedes` (the ledger is append-only);
 *   - `level` is the two-storey model — the product decides *what can be
 *     chosen* (`product-axis`) or *what is fixed* (`product-fixed`); the
 *     tenant's customer picks *a value on an axis* (`customer-value`);
 *   - `state` is the promotion machine: machine-derived facts are never
 *     `decided`; only a human actor promotes, and only within the authority
 *     of their `level` (see `promote.ts`).
 */
import type { ActorRef } from '../actor.js';

export const DECISION_LEVELS = [
  'product-fixed',
  'product-axis',
  'customer-value',
  'undecided',
] as const;
export type DecisionLevel = (typeof DECISION_LEVELS)[number];

export const DECISION_STATES = ['observed', 'enacted', 'proposed', 'decided', 'rejected'] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

export const DECISION_AUTHORITIES = [
  'product',
  'customer',
  'core-system',
  'platform',
  'regulation',
  'environment',
] as const;
export type DecisionAuthority = (typeof DECISION_AUTHORITIES)[number];

export const DECISION_ORIGINS = [
  'transcribed',
  'console',
  'hearing',
  'facade',
  'ssot-sync',
  'observation',
] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

/** `^D-\d{4,}$` — the ledger assigns these sequentially per case. */
export const DECISION_ID_PATTERN = /^D-\d{4,}$/u;
/** Case ids and tenant-owned item/key names share one safe-segment grammar. */
export const DECISION_SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#:@+-]{0,120}$/u;
export const DECISION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/u;

export interface DecisionBasis {
  /** Where the decision comes from: an upstream decision id, a Q&A id, a spec section, a hearing turn. */
  ref: string;
  /** The version of that source the decision was taken against (commit, document revision, turn id). */
  version: string;
  note?: string;
  /** Free-form "who approved this basis, when" carried over from an upstream register. */
  approved?: string;
}

/** SD-04: a member recording a decision that belongs to the tenant's customer. */
export interface DecisionOnBehalfOf {
  /** Customer actor id from the tenant's customer actor registry (`customer:<slug>` grammar). */
  actor_id: string;
  /** Registered confirm target (who to ask) when the customer has not decided yet. */
  confirm_target?: string;
  /** The customer's approval evidence (a reply id, a signed minute, an approval record). Required for `decided`. */
  evidence?: string;
}

/** A human {@link ActorRef} plus the two ledger-specific facts about the decision seam. Not a
 * structural subtype of `ActorRef` because `on_behalf_of` is an object here, not the agent-side
 * `user:<id>` string — use {@link decidedByActorRef} where an `ActorRef` is needed. */
export interface DecisionDecidedBy {
  kind: 'human';
  id: string;
  display_name?: string;
  /** Front-desk role of the deciding member at decision time. */
  role?: 'owner' | 'approver' | 'viewer';
  on_behalf_of?: DecisionOnBehalfOf;
}

export interface DecisionRecord {
  id: string;
  case_id: string;
  item: string;
  key: string;
  level: DecisionLevel;
  state: DecisionState;
  value: unknown;
  /** `product-axis` only: the enumerated choices the customer may pick from. */
  options?: unknown[];
  authority?: DecisionAuthority;
  basis: DecisionBasis[];
  /** External references this decision is bound to (spec ids with versions live in `basis`). */
  bound_to?: string[];
  decided_by?: DecisionDecidedBy;
  decided_at?: string;
  proposed_by?: ActorRef;
  proposed_at?: string;
  origin: DecisionOrigin;
  status: 'active' | 'superseded';
  supersedes?: string;
  /** Why `decided` was refused and the record stayed `proposed` (set by `promote.ts`). */
  pending_reason?: string;
  note?: string;
  /** Hearing turn (`request_id`) the value was taken from, when `origin: 'hearing'`. */
  source_turn?: string;
}

/** What the machine observed in an implementation for one decision key. */
export interface DecisionObservation {
  key: string;
  value: unknown;
  /** `file:line` or equivalent locator in the observed implementation. */
  ref: string;
  quote?: string;
  /** The observer decided this value comes from a superseded source (older spec revision). */
  stale?: boolean;
}

export interface DecisionObservedSet {
  case_id: string;
  /** Implementation identity: repository + commit the observations were taken from. */
  impl: { repo: string; commit: string; note?: string };
  observed_at: string;
  observations: DecisionObservation[];
}

export type DecisionVerdict = 'match' | 'conflict' | 'stale' | 'unprobed';

export interface DecisionConformanceCheck {
  decision: string;
  item: string;
  key: string;
  verdict: DecisionVerdict;
  why: string;
  decided: unknown;
  observed?: unknown;
  impl_ref?: string;
}

export interface DecisionConformanceReport {
  case_id: string;
  checked_at: string;
  impl?: DecisionObservedSet['impl'];
  tally: Partial<Record<DecisionVerdict, number>>;
  status: 'green' | 'red';
  checks: DecisionConformanceCheck[];
}

/** Frozen view of the decisions an implementation was checked against — committed into the implementation repo. */
export interface DecisionLock {
  version: '1.0.0';
  case_id: string;
  generated_at: string;
  impl?: DecisionObservedSet['impl'];
  status: 'green' | 'red';
  decisions: Array<{
    id: string;
    item: string;
    key: string;
    level: DecisionLevel;
    value: unknown;
    basis: Array<Pick<DecisionBasis, 'ref' | 'version'>>;
  }>;
}

/** A customer actor the tenant may record decisions for (SD-04). Kept inside the tenant. */
export interface DecisionCustomerActor {
  id: string;
  name: string;
  /** What this actor is entitled to decide: `customer-value` always; others by contract. */
  decides: DecisionLevel[];
  confirm_target?: string;
  note?: string;
}

export interface DecisionCustomerActorRegistry {
  version: '1.0.0';
  tenant_slug: string;
  customer: string;
  actors: DecisionCustomerActor[];
}

export const CUSTOMER_ACTOR_ID_PATTERN = /^customer:[a-z][a-z0-9-]{0,60}$/u;

export function decidedByActorRef(decidedBy: DecisionDecidedBy): ActorRef {
  return {
    kind: decidedBy.kind,
    id: decidedBy.id,
    ...(decidedBy.display_name ? { display_name: decidedBy.display_name } : {}),
  };
}

// ---------------------------------------------------------------------------
// Grammar and layout — the single place these values are written down
// ---------------------------------------------------------------------------

/** Case ids and hearing session ids share one safe-segment grammar. */
export const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;
/** A tenant's customer slug (the directory under `customers/`). */
export const CUSTOMER_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,60}$/u;
/** Prefix of a ledger hearing scenario id: `decisions-<case>-<product|customer>`. */
export const DECISIONS_SCENARIO_PREFIX = 'decisions';

/** Where a tenant's ledger lives and what its files are called (SD-00 §2.1). */
export const DECISION_LEDGER_LAYOUT = {
  confidentialRoot: 'knowledge/confidential',
  decisionsDir: 'decisions',
  customersDir: 'customers',
  conceptsDir: 'concepts',
  files: {
    decisions: 'decisions.jsonl',
    observed: 'observed.json',
    lock: 'lock.json',
    report: 'report.json',
    probes: 'probes.json',
    actors: 'actors.json',
  },
} as const;

/**
 * Authority roles the ledger runs under. Both ledger reads and writes use the tenant-scoped
 * `decision_ledger` role; `memberLookup` is for the member registry, which is not ledger data.
 */
export const DECISION_LEDGER_ROLES = {
  write: 'decision_ledger',
  read: 'decision_ledger',
  memberLookup: 'ecosystem_architect',
} as const;

export function isDecisionLevel(value: unknown): value is DecisionLevel {
  return typeof value === 'string' && (DECISION_LEVELS as readonly string[]).includes(value);
}

export function isDecisionState(value: unknown): value is DecisionState {
  return typeof value === 'string' && (DECISION_STATES as readonly string[]).includes(value);
}

/** Stable JSON for value comparison — key order must not make two equal values differ. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
