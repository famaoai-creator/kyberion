import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  pathResolver,
  safeExistsSync,
} from './intelligence-primitives';
import { assertSafeRepositoryPath, safeLstat } from '@agent/core/secure-io';
import { BoundedRingBuffer, CE_STREAM_LIMITS } from '@agent/core/ce-adoption';
import { isRecord, nowIso, readJsonLines } from '@agent/core/foundation';
import { optionalStringField, stringField } from './json-record';

export interface AgentMessageSummary {
  ts: string;
  missionId?: string;
  agentId: string;
  teamRole?: string;
  ownerId: string;
  ownerType: string;
  channel?: string;
  thread?: string;
  type: 'handoff' | 'prompt' | 'agent' | 'stderr';
  tone: 'request' | 'response' | 'runtime';
  content: string;
}

export interface A2AHandoffSummary {
  ts: string;
  missionId: string;
  sender: string;
  receiver: string;
  teamRole?: string;
  channel?: string;
  thread?: string;
  performative?: string;
  intent?: string;
  promptExcerpt?: string;
}

type RuntimeLeaseSummary = ReturnType<typeof listAgentRuntimeLeaseSummaries>[number];
type RuntimeSnapshot = ReturnType<typeof listAgentRuntimeSnapshots>[number];

function appendRuntimeMessages(
  messages: AgentMessageSummary[],
  leaseByAgent: Map<string, RuntimeLeaseSummary>,
  runtimeSnapshots: RuntimeSnapshot[]
): void {
  for (const snapshot of runtimeSnapshots) {
    const lease = leaseByAgent.get(snapshot.agent.agentId);
    if (!lease) continue;

    const missionId =
      lease.owner_type === 'mission'
        ? lease.owner_id
        : typeof lease.metadata?.mission_id === 'string'
          ? lease.metadata.mission_id
          : undefined;
    if (!missionId) continue;

    for (const entry of snapshot.logs || []) {
      if (entry.type !== 'prompt' && entry.type !== 'agent' && entry.type !== 'stderr') continue;
      const normalized = entry.content.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      messages.push({
        ts: new Date(entry.ts).toISOString(),
        missionId,
        agentId: snapshot.agent.agentId,
        teamRole:
          typeof lease.metadata?.team_role === 'string' ? lease.metadata.team_role : undefined,
        ownerId: lease.owner_id,
        ownerType: lease.owner_type,
        channel: typeof lease.metadata?.channel === 'string' ? lease.metadata.channel : undefined,
        thread: typeof lease.metadata?.thread === 'string' ? lease.metadata.thread : undefined,
        type: entry.type,
        tone: entry.type === 'prompt' ? 'request' : entry.type === 'agent' ? 'response' : 'runtime',
        content: normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized,
      });
    }
  }
}

export interface AgentMessageFeedOptions {
  observationPath?: string;
}

function readObservedA2AHandoffs(options: AgentMessageFeedOptions = {}): A2AHandoffSummary[] {
  const observationPath =
    options.observationPath ||
    pathResolver.shared('observability/mission-control/orchestration-events.jsonl');
  try {
    const safeObservationPath = assertSafeRepositoryPath(observationPath, {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(safeObservationPath) || !safeLstat(safeObservationPath).isFile()) return [];

    const handoffs: A2AHandoffSummary[] = [];
    const events = readJsonLines<Record<string, unknown>>(safeObservationPath, {
      map: (value) => {
        if (!isRecord(value)) throw new Error('A2A observation JSONL entry must be an object');
        return value;
      },
      onMalformed: 'skip',
    });
    for (const event of events) {
      try {
        if (
          (stringField(event, 'decision') || stringField(event, 'event_type')) !==
          'a2a_message_routed'
        )
          continue;
        const missionId = stringField(event, 'mission_id');
        if (!missionId) continue;

        handoffs.push({
          ts: stringField(event, 'ts', nowIso()),
          missionId,
          sender: stringField(event, 'sender', 'unknown'),
          receiver: stringField(event, 'receiver', 'unknown'),
          teamRole: optionalStringField(event, 'team_role'),
          channel: optionalStringField(event, 'channel'),
          thread: optionalStringField(event, 'thread'),
          performative: optionalStringField(event, 'performative'),
          intent: optionalStringField(event, 'intent'),
          promptExcerpt: optionalStringField(event, 'prompt_excerpt'),
        });
      } catch {
        // Ignore malformed lines.
      }
    }

    const bounded = new BoundedRingBuffer<A2AHandoffSummary>(CE_STREAM_LIMITS.maxLiveMessages);
    // The ring buffer is FIFO: feed oldest-first so overflow sheds old history,
    // then restore the operator-facing newest-first order.
    for (const handoff of handoffs.sort((a, b) => a.ts.localeCompare(b.ts))) bounded.push(handoff);
    return bounded.toArray().reverse().slice(0, 24);
  } catch {
    return [];
  }
}

function appendObservedA2AHandoffs(
  messages: AgentMessageSummary[],
  handoffs: A2AHandoffSummary[]
): void {
  for (const handoff of handoffs) {
    messages.push({
      ts: handoff.ts,
      missionId: handoff.missionId,
      agentId: handoff.receiver,
      teamRole: handoff.teamRole,
      ownerId: handoff.missionId,
      ownerType: 'mission',
      channel: handoff.channel,
      thread: handoff.thread,
      type: 'handoff',
      tone: 'request',
      content: handoff.promptExcerpt
        ? `handoff from ${handoff.sender} -> ${handoff.receiver}: ${handoff.promptExcerpt}`
        : `handoff from ${handoff.sender} -> ${handoff.receiver}`,
    });
  }
}

export function collectAgentMessages(options: AgentMessageFeedOptions = {}): AgentMessageSummary[] {
  const runtimeLeases = listAgentRuntimeLeaseSummaries();
  const runtimeSnapshots = listAgentRuntimeSnapshots();
  const leaseByAgent = new Map(runtimeLeases.map((lease) => [lease.agent_id, lease]));
  const messages: AgentMessageSummary[] = [];
  const handoffs = readObservedA2AHandoffs(options);

  appendRuntimeMessages(messages, leaseByAgent, runtimeSnapshots);
  appendObservedA2AHandoffs(messages, handoffs);

  const bounded = new BoundedRingBuffer<AgentMessageSummary>(CE_STREAM_LIMITS.maxLiveMessages);
  // Feed oldest-first so a bounded buffer retains the newest messages rather
  // than the oldest tail of an already descending list.
  for (const message of messages.sort((a, b) => a.ts.localeCompare(b.ts))) bounded.push(message);
  return bounded.toArray().reverse().slice(0, 40);
}

export function collectA2AHandoffs(options: AgentMessageFeedOptions = {}): A2AHandoffSummary[] {
  return readObservedA2AHandoffs(options);
}
