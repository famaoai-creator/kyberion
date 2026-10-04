/**
 * The Conversation Engine's single legible turn state (CE-01).
 *
 * Kept deliberately small — the concept caps out around six states:
 *
 *   LISTENING   default; the floor is free or the remote party holds it and
 *               the agent is simply taking it in.
 *   HOLDING     the agent is holding an unfinished remote turn (EOT hold) or
 *               waiting for a trailing final transcript before deciding.
 *   BACKCHANNEL the remote party holds the floor and the agent is emitting a
 *               short reaction (aizuchi) instead of a full reply.
 *   TAKING      the agent is preparing to take the floor (speculative reply
 *               armed) or has just been handed it (committed turn).
 *   SPEAKING    agent output is actively being emitted.
 *   YIELDING    agent output is provisionally paused — an interruption is
 *               being evaluated but not yet confirmed.
 *
 * Pure — the state is *derived* from engine internals, never stored.
 */

export type InteractionState =
  'listening' | 'holding' | 'backchannel' | 'taking' | 'speaking' | 'yielding';

export interface InteractionStateInput {
  /** Agent output currently being emitted. */
  outputActive: boolean;
  /** Output is provisionally paused while an interruption is evaluated. */
  outputPaused: boolean;
  /** Remote party currently holds the floor. */
  remoteSpeaking: boolean;
  /** An unfinished turn is being held for continuation (EOT hold). */
  eotPending: boolean;
  /** Waiting for a final transcript after silence. */
  awaitingFinal: boolean;
  /** Agent is emitting a short reaction while the remote party keeps the floor. */
  emittingBackchannel: boolean;
  /** Speculative reply armed, or a commit just dispatched. */
  preparingToAct: boolean;
}

export function deriveInteractionState(input: InteractionStateInput): InteractionState {
  if (input.emittingBackchannel) return 'backchannel';
  if (input.outputPaused) return 'yielding';
  if (input.outputActive) return 'speaking';
  if (input.preparingToAct) return 'taking';
  if (input.eotPending || input.awaitingFinal) return 'holding';
  return 'listening';
}
