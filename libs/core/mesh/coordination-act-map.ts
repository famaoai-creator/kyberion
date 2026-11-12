/**
 * Per-layer mapping from each communication layer's own kinds to the canonical
 * coordination acts (`libs/core/foundation/coordination-act.ts`).
 *
 * This is a mapping, not a wire format: no layer's members, envelopes, stored
 * rows, schemas or signed payloads change. Each table is a
 * `Record<LayerKind, CoordinationActMapping>`, so the compiler rejects a table
 * that misses a kind or names one the layer does not have; for layers that
 * export a const array, `tests/coordination-act-boundary.test.ts` repeats the
 * check at runtime and also fails when a communication module declares a new
 * act-like union without registering here.
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
} from './mesh-hub-peer-messaging-adapter.js';
import type {
  PEER_TASK_REQUEST_KIND,
  PEER_TASK_RESULT_KIND,
  PEER_TASK_RESULT_STATUSES,
  PeerTaskRecord,
  PeerTaskState,
} from './peer-task-exchange.js';
import type { CoSessionHandoffKind } from '../workforce/co-session.js';
import type { WorkCoordinationPeerCommandType } from '../workforce/work-coordination-peer.js';
import type { MissionCoordinationChannel } from '../mission/mission-coordination-bus.js';
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

/** In-runtime A2A bridge envelope `header.performative` (the A2A mechanism that carries traffic). */
export const A2A_PERFORMATIVE_ACTS = actTable<A2APerformative>({
  request: 'request',
  propose: 'propose',
  inform: 'inform',
  accept: 'accept',
  reject: 'reject',
  query: 'query',
  result: 'result',
});

/** Runtime ↔ runtime signed peer envelope `type`. */
export const PEER_MESSAGE_TYPE_ACTS = actTable<PeerMessageType>({
  request: 'request',
  reply: 'result',
  notification: 'inform',
  handoff: 'handoff',
  capability_query: 'query',
  capability_response: 'result',
});

/**
 * Peer conversation transcript `kind`. A typed peer task rides on `handoff`
 * (request) and `status` (result); the task layer below names those acts.
 */
export const PEER_CONVERSATION_MESSAGE_KIND_ACTS = actTable<PeerConversationMessageKind>({
  open: notACoordinationAct('session control: opens a conversation session'),
  message: 'inform',
  reply: 'result',
  handoff: 'handoff',
  close: notACoordinationAct('session control: closes a conversation session'),
  status: 'inform',
});

/** Mesh Hub allowlisted collaboration request kinds (`MESH_REQUEST_KINDS`). */
export const MESH_REQUEST_KIND_ACTS = actTable<MeshRequestKind>({
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

/** Typed peer task message kinds. */
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
 * Work coordination peer command `command_type`: what a Mesh Hub `workitem.*`
 * proposal carries once accepted (`buildWorkitemCommand` maps the request kind
 * onto it), so each command maps like its request kind.
 */
export const WORK_COORDINATION_PEER_COMMAND_ACTS = actTable<WorkCoordinationPeerCommandType>({
  claim_request: 'request',
  handoff_request: 'handoff',
  status_update: 'inform',
});

/** Co-Session handoff `kind` (a subset of the Mesh request kinds; the shared members map alike). */
export const CO_SESSION_HANDOFF_KIND_ACTS = actTable<CoSessionHandoffKind>({
  'review.request': 'request',
  'workitem.claim': 'request',
  'workitem.handoff': 'handoff',
  'workitem.status_update': 'inform',
  'notification.publish': 'inform',
});

/**
 * Mission coordination bus `channel`. The bus is a visibility record of acts
 * performed elsewhere (dispatch, rework handoff); each channel maps to the act
 * its rows describe. No recipient decides anything from a bus row.
 */
export const MISSION_COORDINATION_CHANNEL_ACTS = actTable<MissionCoordinationChannel>({
  task_contract: 'request',
  handoff: 'handoff',
  review: 'request',
  runtime_notice: 'inform',
});

/**
 * Agent execution port messages. The port has no kind union; its two message
 * shapes are a typed task request (`AgentTaskEnvelope`) and its receipt.
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
