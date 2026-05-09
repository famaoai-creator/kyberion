import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  pathResolver,
  safeExistsSync,
  safeReadFile,
} from "@agent/core/intelligence-primitives";

export interface AgentMessageSummary {
  ts: string;
  missionId?: string;
  agentId: string;
  teamRole?: string;
  ownerId: string;
  ownerType: string;
  channel?: string;
  thread?: string;
  type: "handoff" | "prompt" | "agent" | "stderr";
  tone: "request" | "response" | "runtime";
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
  runtimeSnapshots: RuntimeSnapshot[],
): void {
  for (const snapshot of runtimeSnapshots) {
    const lease = leaseByAgent.get(snapshot.agent.agentId);
    if (!lease) continue;

    const missionId =
      lease.owner_type === "mission"
        ? lease.owner_id
        : typeof lease.metadata?.mission_id === "string"
          ? lease.metadata.mission_id
          : undefined;
    if (!missionId) continue;

    for (const entry of snapshot.logs || []) {
      if (entry.type !== "prompt" && entry.type !== "agent" && entry.type !== "stderr") continue;
      const normalized = entry.content.replace(/\s+/g, " ").trim();
      if (!normalized) continue;

      messages.push({
        ts: new Date(entry.ts).toISOString(),
        missionId,
        agentId: snapshot.agent.agentId,
        teamRole: typeof lease.metadata?.team_role === "string" ? lease.metadata.team_role : undefined,
        ownerId: lease.owner_id,
        ownerType: lease.owner_type,
        channel: typeof lease.metadata?.channel === "string" ? lease.metadata.channel : undefined,
        thread: typeof lease.metadata?.thread === "string" ? lease.metadata.thread : undefined,
        type: entry.type,
        tone: entry.type === "prompt" ? "request" : entry.type === "agent" ? "response" : "runtime",
        content: normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized,
      });
    }
  }
}

function readObservedA2AHandoffs(): A2AHandoffSummary[] {
  const observationPath = pathResolver.shared("observability/mission-control/orchestration-events.jsonl");
  if (!safeExistsSync(observationPath)) return [];

  const handoffs: A2AHandoffSummary[] = [];
  const raw = safeReadFile(observationPath, { encoding: "utf8" }) as string;
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      if ((event.decision || event.event_type) !== "a2a_message_routed") continue;
      if (typeof event.mission_id !== "string" || !event.mission_id) continue;

      handoffs.push({
        ts: event.ts || new Date().toISOString(),
        missionId: event.mission_id,
        sender: typeof event.sender === "string" ? event.sender : "unknown",
        receiver: typeof event.receiver === "string" ? event.receiver : "unknown",
        teamRole: typeof event.team_role === "string" ? event.team_role : undefined,
        channel: typeof event.channel === "string" ? event.channel : undefined,
        thread: typeof event.thread === "string" ? event.thread : undefined,
        performative: typeof event.performative === "string" ? event.performative : undefined,
        intent: typeof event.intent === "string" ? event.intent : undefined,
        promptExcerpt: typeof event.prompt_excerpt === "string" ? event.prompt_excerpt : undefined,
      });
    } catch {
      // Ignore malformed lines.
    }
  }

  return handoffs
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 24);
}

function appendObservedA2AHandoffs(messages: AgentMessageSummary[], handoffs: A2AHandoffSummary[]): void {
  for (const handoff of handoffs) {
    messages.push({
      ts: handoff.ts,
      missionId: handoff.missionId,
      agentId: handoff.receiver,
      teamRole: handoff.teamRole,
      ownerId: handoff.missionId,
      ownerType: "mission",
      channel: handoff.channel,
      thread: handoff.thread,
      type: "handoff",
      tone: "request",
      content: handoff.promptExcerpt
        ? `handoff from ${handoff.sender} -> ${handoff.receiver}: ${handoff.promptExcerpt}`
        : `handoff from ${handoff.sender} -> ${handoff.receiver}`,
    });
  }
}

export function collectAgentMessages(): AgentMessageSummary[] {
  const runtimeLeases = listAgentRuntimeLeaseSummaries();
  const runtimeSnapshots = listAgentRuntimeSnapshots();
  const leaseByAgent = new Map(runtimeLeases.map((lease) => [lease.agent_id, lease]));
  const messages: AgentMessageSummary[] = [];
  const handoffs = readObservedA2AHandoffs();

  appendRuntimeMessages(messages, leaseByAgent, runtimeSnapshots);
  appendObservedA2AHandoffs(messages, handoffs);

  return messages
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 40);
}

export function collectA2AHandoffs(): A2AHandoffSummary[] {
  return readObservedA2AHandoffs();
}
