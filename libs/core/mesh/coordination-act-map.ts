/**
 * Per-layer mapping from each communication layer's own kinds to the canonical
 * coordination acts (`libs/core/foundation/coordination-act.ts`).
 *
 * This is a mapping, not a wire format: no layer's members, envelopes, stored
 * rows, schemas or signed payloads change. Each table is built from a
 * `Record<LayerKind, CoordinationActMapping>` literal, so `tsc` rejects a table
 * that misses a kind of its key type, adds a kind, or targets a non-act. The
 * key type is the layer's own union, except for the two hand-written key sets
 * noted below. `tests/coordination-act-boundary.test.ts` adds runtime checks
 * for the layers that export a const array, and scans the communication
 * directories for unregistered act-like declarations. Agent-communication
 * model §11.2 lists exactly what is and is not covered.
 *
 * Tables follow rule A (`propose` only where a separate recipient decision is
 * recorded) and rule B (the innermost typed layer names the act; outer
 * envelope kinds are carriers); see `coordination-act.ts`.
 *
 * Only type imports from the layers, so this module adds no runtime edge and
 * no import cycle. Its only consumer today is the gate; nothing routes on it.
 * Model and table: knowledge/product/architecture/agent-communication-layer-model.md §11.
 */
import {
  notACoordinationAct,
  type CoordinationActMapping,
} from '../foundation/coordination-act.js';
import type { A2APerformative } from './a2a-bridge.js';
import type { PeerMessageType } from './peer-messaging.js';
import type { PeerConversationMessageKind } from './peer-conversation.js';
import type { MeshDeliveryStatus, MeshRequestKind } from './mesh-hub-contract.js';
import type {
  MeshHubRecipientProposalDecision,
  MeshHubRecipientProposalRecord,
  MeshHubWorkitemCommandPayload,
} from './mesh-hub-peer-messaging-adapter.js';
import type {
  PEER_TASK_REQUEST_KIND,
  PEER_TASK_RESULT_KIND,
  PEER_TASK_RESULT_STATUSES,
  PeerTaskRecord,
  PeerTaskState,
} from './peer-task-exchange.js';
import type { CoSessionHandoffKind } from '../workforce/co-session.js';
import type { MissionCoordinationChannel } from '../mission/mission-coordination-record.js';
import type { AgentExecutionReceiptStatus } from '../agent/agent-execution-port.js';
import type { DiscussionPerformative } from '../discussion/discussion-types.js';

type ActTable<K extends string> = Readonly<Record<K, CoordinationActMapping>>;

/**
 * Freeze one layer table. Passing the literal straight to a `Record<K, …>`
 * parameter keeps the excess-property check, so a missing kind, an extra kind
 * and a target outside the canonical set are all compile errors.
 */
function actTable<K extends string>(table: Record<K, CoordinationActMapping>): ActTable<K> {
  return Object.freeze(table);
}

const REFUSED_BY_BRIDGE = notACoordinationAct(
  'refused by the bridge: it has no proposal store and records no recipient decision, so it cannot honour this performative'
);

/**
 * In-runtime A2A bridge envelope `header.performative` (the A2A mechanism that
 * carries traffic). `A2ABridge.route()` delivers only
 * `A2A_ROUTABLE_PERFORMATIVES` (`request`, `query`, `inform`) to an agent, as
 * a prompt. All three run exactly like `request`: this table names what the
 * sender says, and `query` / `inform` are not a no-side-effect guarantee on
 * the bridge. It refuses every other value with `A2APerformativeNotRoutableError`
 * after the sender and signature checks and before any spawn. `propose`,
 * `accept` and `reject` would claim a recipient decision the bridge does not
 * record, so they are not acts here. `result` is the act of the envelope the
 * bridge returns; an inbound `result` is refused like the others.
 */
export const A2A_PERFORMATIVE_ACTS = actTable<A2APerformative>({
  request: 'request',
  propose: REFUSED_BY_BRIDGE,
  inform: 'inform',
  accept: REFUSED_BY_BRIDGE,
  reject: REFUSED_BY_BRIDGE,
  query: 'query',
  result: 'result',
});

/**
 * Runtime ↔ runtime signed peer envelope `type`. This mapping applies only
 * when the peer envelope is the innermost typed layer (a direct `peer send`).
 * Otherwise the envelope is a carrier (rule B): peer conversation sends every
 * message as `type: 'request'` (replies and status included), and the Mesh
 * workitem command is built as `type: 'request'` too.
 */
export const PEER_MESSAGE_TYPE_ACTS = actTable<PeerMessageType>({
  request: 'request',
  reply: 'result',
  notification: 'inform',
  handoff: 'handoff',
  capability_query: 'query',
  capability_response: 'result',
});

/**
 * Peer conversation transcript `kind`. By rule B a kind that carries a typed
 * record is a carrier: `handoff` carries a peer task proposal
 * (`peer-task-exchange.ts`) or a Mesh collaboration request
 * (`scripts/peer_conversation_server.ts`), and those records name the act. A
 * `status` that carries a `peer-task-result` likewise defers to the task layer;
 * a plain `status` (auto-reply acknowledgement) is `inform`. The listener also
 * answers a carried proposal with a `reply` / `status` transport receipt
 * ("pending local acceptance"); that receipt is stage 1–3 evidence, not the
 * recipient's decision.
 */
export const PEER_CONVERSATION_MESSAGE_KIND_ACTS = actTable<PeerConversationMessageKind>({
  open: notACoordinationAct('session control: opens a conversation session'),
  message: 'inform',
  reply: 'result',
  handoff: notACoordinationAct(
    'carrier: holds a peer task proposal or a Mesh collaboration request, whose record names the act; not a transfer of responsibility'
  ),
  close: notACoordinationAct('session control: closes a conversation session'),
  status: 'inform',
});

/**
 * Mesh Hub recipient records. In v1 every allowlisted collaboration request
 * travels as a recipient proposal: the adapter stores each kind as a pending
 * proposal (for non-`workitem.*` kinds `buildA2AProposal` labels the stored
 * payload `propose`), and only the
 * recipient's local decision record moves it on. The proposal record is
 * therefore the `propose`; the decision record carries the `accept` /
 * `reject` named by `MESH_PROPOSAL_DECISION_ACTS`.
 */
export const MESH_RECIPIENT_RECORD_ACTS = actTable<
  MeshHubRecipientProposalRecord['kind'] | MeshHubRecipientProposalDecision['kind']
>({
  'mesh-hub-recipient-proposal': 'propose',
  'mesh-hub-recipient-proposal-decision': notACoordinationAct(
    'carrier of the recipient decision; its decision field names accept / reject'
  ),
});

/**
 * Content acts of the Mesh Hub allowlisted request kinds (`MESH_REQUEST_KINDS`):
 * WHAT a proposal asks for, not how it is delivered. The delivered message is
 * always the `propose` of `MESH_RECIPIENT_RECORD_ACTS`, so `workitem.claim →
 * request` does not mean the claim runs without acceptance.
 */
export const MESH_REQUEST_KIND_CONTENT_ACTS = actTable<MeshRequestKind>({
  'review.request': 'request',
  'workitem.claim': 'request',
  'workitem.handoff': 'handoff',
  'workitem.status_update': 'inform',
  'capability.query': 'query',
  'notification.publish': 'inform',
});

const DELIVERY_STATE = notACoordinationAct(
  'delivery-journal state of one message, not a message; acceptance here is broker acceptance, not the recipient decision'
);

/** Mesh delivery journal statuses (`MESH_DELIVERY_STATUSES`). */
export const MESH_DELIVERY_STATUS_ACTS = actTable<MeshDeliveryStatus>({
  accepted: DELIVERY_STATE,
  queued: DELIVERY_STATE,
  dispatched: DELIVERY_STATE,
  acknowledged: DELIVERY_STATE,
  completed: DELIVERY_STATE,
  rejected: DELIVERY_STATE,
  expired: DELIVERY_STATE,
  dead_lettered: DELIVERY_STATE,
});

/**
 * Mesh Hub recipient proposal `proposal_kind`: which payload the stored
 * proposal holds. The `a2a-message` payload is a stored record; nothing
 * executes or routes it through the A2A bridge.
 */
export const MESH_PROPOSAL_KIND_ACTS = actTable<MeshHubRecipientProposalRecord['proposal_kind']>({
  a2a: notACoordinationAct('category of stored proposal record (holds an a2a-message payload)'),
  workitem: notACoordinationAct(
    'category of stored proposal record (holds a workitem-command payload)'
  ),
});

/** Mesh Hub recipient proposal decision (the recipient's stage-4 decision). */
export const MESH_PROPOSAL_DECISION_ACTS = actTable<MeshHubRecipientProposalDecision['decision']>({
  accepted: 'accept',
  rejected: 'reject',
});

/**
 * Typed peer task message kinds. Hand-written key set: the two kind constants
 * are separate exports, so a third task message kind would not reach this
 * table's key type. Compile-time only.
 */
export const PEER_TASK_MESSAGE_KIND_ACTS = actTable<
  typeof PEER_TASK_REQUEST_KIND | typeof PEER_TASK_RESULT_KIND
>({
  'peer-task-request': 'propose',
  'peer-task-result': 'result',
});

/** Typed peer task local decision (`peer:task accept` / reject). */
export const PEER_TASK_DECISION_ACTS = actTable<
  NonNullable<PeerTaskRecord['decision']>['decision']
>({
  accepted: 'accept',
  rejected: 'reject',
});

const TASK_STATE = notACoordinationAct(
  'recorded task-exchange state (receipt, acceptance, execution, result kept distinct), not a message'
);

/** Typed peer task ledger states (`PEER_TASK_STATES`). */
export const PEER_TASK_STATE_ACTS = actTable<PeerTaskState>({
  pending: TASK_STATE,
  accepted: TASK_STATE,
  running: TASK_STATE,
  completed: TASK_STATE,
  failed: TASK_STATE,
  rejected: TASK_STATE,
  expired: TASK_STATE,
});

const RESULT_OUTCOME = notACoordinationAct(
  'outcome field carried inside a peer-task-result message, not a message of its own'
);

/** Typed peer task result `status` (`PEER_TASK_RESULT_STATUSES`). */
export const PEER_TASK_RESULT_STATUS_ACTS = actTable<(typeof PEER_TASK_RESULT_STATUSES)[number]>({
  completed: RESULT_OUTCOME,
  failed: RESULT_OUTCOME,
  rejected: RESULT_OUTCOME,
});

/**
 * Content acts of the `command_type` in the `workitem-command` payload stored
 * with a Mesh Hub recipient proposal: a record of what a `workitem.*` request
 * asked for. Nothing executes it; each command maps like its request kind.
 */
export const MESH_WORKITEM_COMMAND_CONTENT_ACTS = actTable<
  MeshHubWorkitemCommandPayload['command_type']
>({
  claim_request: 'request',
  handoff_request: 'handoff',
  status_update: 'inform',
});

/**
 * Co-Session handoff `kind` (a subset of the Mesh request kinds; the shared
 * members map alike). Here the kind is the delivered act: there is no
 * proposal record, and `acked_at` is a read receipt, not a recipient
 * decision, so asks are `request` (rule A). A Co-Session handoff is
 * cooperative; ownership still moves only through a WorkItem claim.
 */
export const CO_SESSION_HANDOFF_KIND_ACTS = actTable<CoSessionHandoffKind>({
  'review.request': 'request',
  'workitem.claim': 'request',
  'workitem.handoff': 'handoff',
  'workitem.status_update': 'inform',
  'notification.publish': 'inform',
});

/**
 * Mission coordination record `channel`. The record lists acts performed
 * elsewhere (dispatch, rework handoff) for visibility; each channel maps to
 * the act its rows describe. No recipient decides anything from a row: inside
 * one runtime the owner's dispatch runs on receipt. Neither `task_contract`
 * nor `runtime_notice` has a producer today.
 */
export const MISSION_COORDINATION_CHANNEL_ACTS = actTable<MissionCoordinationChannel>({
  task_contract: 'request',
  handoff: 'handoff',
  review: 'request',
  runtime_notice: 'inform',
});

/**
 * Agent execution port messages. Hand-written key set: the port has no kind
 * union, so its two message shapes are named here and a third shape would not
 * be detected. Compile-time only. With a `work_item_id`, `delegate()` re-derives
 * the lease and capability profile from the claimed WorkItem. Without one the
 * task is unclaimed: no lease, work item or profile reaches the runtime, the
 * request mission must equal the scope mission, and the run is recorded as
 * `agent_delegation_unclaimed`. The unclaimed runtime's own tools are not yet
 * narrowed (agent-communication-layer-model.md §9).
 */
export const AGENT_EXECUTION_PORT_MESSAGE_ACTS = actTable<
  'AgentTaskEnvelope' | 'AgentExecutionReceipt'
>({
  AgentTaskEnvelope: 'request',
  AgentExecutionReceipt: 'result',
});

const EXECUTION_STATE = notACoordinationAct(
  'execution state reported inside an AgentExecutionReceipt, not a message'
);

/** Agent execution receipt `status` (`AGENT_EXECUTION_RECEIPT_STATUSES`). */
export const AGENT_EXECUTION_RECEIPT_STATUS_ACTS = actTable<AgentExecutionReceiptStatus>({
  submitted: EXECUTION_STATE,
  running: EXECUTION_STATE,
  succeeded: EXECUTION_STATE,
  failed: EXECUTION_STATE,
  canceled: EXECUTION_STATE,
});

const DELIBERATION_MOVE = notACoordinationAct(
  'deliberation move inside a discussion room: it offers or weighs a position, not work, and no recipient decision follows'
);

/**
 * Discussion room `performative`. Turns that only tell map to `inform`;
 * proposing, challenging and agreeing with a position are deliberation, not
 * coordination (a discussion `propose` is not a stage-4 proposal).
 */
export const DISCUSSION_PERFORMATIVE_ACTS = actTable<DiscussionPerformative>({
  inform: 'inform',
  propose: DELIBERATION_MOVE,
  challenge: DELIBERATION_MOVE,
  agree: DELIBERATION_MOVE,
  summarize: 'inform',
});
