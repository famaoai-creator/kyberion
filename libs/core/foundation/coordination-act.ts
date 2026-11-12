/**
 * Coordination acts: the one closed vocabulary of speech acts that agents and
 * runtimes exchange, whatever layer carries them.
 *
 * Every communication layer keeps its own wire vocabulary (A2A `performative`,
 * peer `PeerMessageType`, Mesh `MESH_REQUEST_KINDS`, Co-Session handoff kinds,
 * …). Those members are stored, signed and validated as they are, so they are
 * never renamed to these acts. Instead each layer kind maps to one act, or to
 * an explicit "not an act" with a reason, in
 * `libs/core/mesh/coordination-act-map.ts`. `tests/coordination-act-boundary.test.ts`
 * and `tsc` check those tables; what each one covers is listed in
 * agent-communication-layer-model.md §11.2.
 *
 * The stages named below are the ordered checks of the communication model
 * (knowledge/product/architecture/agent-communication-layer-model.md §5:
 * reachability → authentication → scope authorization → recipient acceptance →
 * execution authority). **No act carries execution authority.** Across
 * runtimes, execution is decided at stage 5 by the recipient's local WorkItem
 * claim. Inside one runtime (§3 D), delegated work runs on receipt under the
 * sender's own authority (mission owner or lease holder), which is established
 * outside the message. Either way, a message can at most ask for work, decide
 * on it (accept / reject) or report it.
 *
 * Two rules decide which act a layer kind maps to:
 *
 * - **Rule A (which act).** `propose` is work offered that stays pending until
 *   the recipient's own decision is recorded as a separate state (typed peer
 *   task, Mesh Hub recipient proposal). `request` is an ask for which the layer
 *   records no separate acceptance.
 * - **Rule B (nesting).** The innermost typed layer names the act. An outer
 *   envelope type is a carrier: a peer conversation message always travels as
 *   peer envelope `type: 'request'`, and a conversation `handoff` carries a peer
 *   task proposal or a Mesh collaboration request.
 *
 * Today the only consumer is the gate test. Nothing routes on these acts at
 * runtime. A reader comparing kinds across layers gets a consistent answer
 * only after applying rule B: find the innermost typed record of a message and
 * read that layer's table, treating every outer kind as a carrier.
 *
 * Dependency-free leaf: keep this file free of imports.
 */
export const COORDINATION_ACTS = Object.freeze([
  /**
   * Ask the recipient to do something; the layer records no separate
   * acceptance (rule A). Across runtimes the ask waits for the recipient's own
   * decision and a local claim before work runs. Inside one runtime (A2A
   * bridge, agent execution port, mission coordination record) delegation
   * runs on receipt under the sender's authority; there is no recipient
   * decision.
   */
  'request',
  /**
   * Offer work or a side effect that stays pending until the recipient's own
   * decision is recorded as a separate state (stage 4). It names work; it does
   * not run it.
   */
  'propose',
  /**
   * The recipient's own stage-4 decision to take on a proposal. Acceptance does
   * not execute anything: execution still needs the stage-5 WorkItem claim on
   * the recipient side.
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
   * moves only when the recipient claims it (stage 5); across runtimes it also
   * waits for the recipient's decision (stage 4).
   */
  'handoff',
] as const);

export type CoordinationAct = (typeof COORDINATION_ACTS)[number];

/** A layer kind that is deliberately not a speech act (a state, a carrier, a category of record, session control). */
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
