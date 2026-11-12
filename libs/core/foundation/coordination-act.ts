/**
 * Coordination acts: the one closed vocabulary of speech acts that agents and
 * runtimes exchange, whatever layer carries them.
 *
 * Every communication layer keeps its own wire vocabulary (A2A `performative`,
 * peer `PeerMessageType`, Mesh `MESH_REQUEST_KINDS`, Co-Session handoff kinds,
 * …). Those members are stored, signed and validated as they are, so they are
 * never renamed to these acts. Instead each layer kind maps to one act, or to
 * an explicit "not an act" with a reason, in
 * `libs/core/mesh/coordination-act-map.ts`; `tests/coordination-act-boundary.test.ts`
 * fails when a layer gains a kind without a mapping.
 *
 * The stages named below are the ordered checks of the communication model
 * (knowledge/product/architecture/agent-communication-layer-model.md §5:
 * reachability → authentication → scope authorization → recipient acceptance →
 * execution authority). **No act carries execution authority.** Execution is
 * decided at stage 5 by a local WorkItem claim or the mission owner; a message
 * of any act can at most ask for it, decide on it (accept / reject) or report it.
 *
 * Today the only consumer is the gate test. Nothing routes on these acts at
 * runtime; a layer that wants to (for example a projection that compares
 * kinds across layers) reads the mapping instead of declaring its own.
 *
 * Dependency-free leaf: keep this file free of imports.
 */
export const COORDINATION_ACTS = Object.freeze([
  /**
   * Ask the recipient to do something. Sent once stages 1–3 pass; whether the
   * work happens is the recipient's stage-4 decision and a stage-5 claim.
   */
  'request',
  /**
   * Offer work or a side effect for the recipient to decide on (stage 4).
   * A proposal is inert until a local accept; it names work, it does not run it.
   */
  'propose',
  /**
   * The recipient's own stage-4 decision to take on a request, proposal or
   * handoff. Acceptance does not execute anything: execution still needs the
   * stage-5 WorkItem claim or mission owner on the recipient side.
   */
  'accept',
  /** The recipient's own stage-4 decision to decline. Terminal for that proposal. */
  'reject',
  /**
   * Tell the recipient something (notification, status, note, conversational
   * turn) with no decision expected. Needs stages 1–3 only.
   */
  'inform',
  /**
   * Ask for information without asking for work (capability query). Answered
   * under scope authorization (stage 3); no acceptance, no side effect.
   */
  'query',
  /**
   * Answer a prior request or query: the reply text, the capability answer, or
   * the outcome of work that a stage-5 holder executed. Reporting a result is
   * not mission completion and is not the user-facing Result record.
   */
  'result',
  /**
   * Transfer responsibility for a piece of work to the recipient. Ownership
   * moves only when the recipient accepts (stage 4) and claims it (stage 5).
   */
  'handoff',
] as const);

export type CoordinationAct = (typeof COORDINATION_ACTS)[number];

/** A layer kind that is deliberately not a speech act (a state, a category of record, session control). */
export interface NotACoordinationAct {
  readonly act: null;
  readonly reason: string;
}

/** What one layer kind means as a coordination act. */
export type CoordinationActMapping = CoordinationAct | NotACoordinationAct;

/** Mark a layer kind as not an act; the reason is required so the gate can show it. */
export function notACoordinationAct(reason: string): NotACoordinationAct {
  return Object.freeze({ act: null, reason });
}

export function isCoordinationAct(value: unknown): value is CoordinationAct {
  return typeof value === 'string' && (COORDINATION_ACTS as readonly string[]).includes(value);
}
