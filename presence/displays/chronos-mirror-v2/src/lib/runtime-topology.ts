import type { AgentMessageSummary, A2AHandoffSummary } from "./agent-message-feed";

export interface RuntimeTopologyRuntime {
  agentId: string;
  provider: string;
  modelId?: string;
  status: string;
  ownerId: string;
  ownerType: string;
  requestedBy?: string;
  leaseKind?: string;
  pid?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTopologyOwner {
  id: string;
  type: string;
  runtimeCount: number;
  runtimeIds: string[];
}

export interface RuntimeTopologySurface {
  id: string;
  kind: string;
  running: boolean;
  startupMode?: string;
  pid?: number;
}

export interface RuntimeTopologyFlow {
  id: string;
  from: string;
  to: string;
  count: number;
  latestAt: string;
  channel?: string;
  thread?: string;
  kind: "a2a" | "agent_message" | "surface_link";
}

export interface RuntimeTopologySnapshot {
  surfaces: RuntimeTopologySurface[];
  owners: RuntimeTopologyOwner[];
  runtimes: Array<RuntimeTopologyRuntime & { recentActivityCount: number }>;
  flows: RuntimeTopologyFlow[];
}

export interface RuntimeTopologyGraphNode {
  id: string;
  label: string;
  kind: "surface" | "runtime" | "peer";
  column: 0 | 1 | 2;
  x: number;
  y: number;
  detail: string;
}

export interface RuntimeTopologyGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "a2a" | "agent_message" | "surface_link";
  count: number;
  latestAt: string;
}

export interface RuntimeTopologyGraph {
  width: number;
  height: number;
  nodes: RuntimeTopologyGraphNode[];
  edges: RuntimeTopologyGraphEdge[];
}

function normalizeTopologyKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstTopologyToken(value: string): string {
  const normalized = normalizeTopologyKey(value);
  return normalized.split(/\s+/)[0] || normalized;
}

function inferRuntimeSurfaceId(
  runtime: RuntimeTopologyRuntime,
  surfaces: RuntimeTopologySurface[],
  runtimeChannelHints: Map<string, Set<string>>,
): string | null {
  const normalizedSurfaceIds = surfaces.map((surface) => ({
    id: surface.id,
    normalized: normalizeTopologyKey(surface.id),
    token: firstTopologyToken(surface.id),
  }));

  const directCandidates = [runtime.ownerId, runtime.requestedBy, runtime.agentId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => ({
      normalized: normalizeTopologyKey(value),
      token: firstTopologyToken(value),
    }));

  for (const candidate of directCandidates) {
    const direct = normalizedSurfaceIds.find((surface) =>
      surface.normalized === candidate.normalized ||
      surface.normalized.includes(candidate.normalized) ||
      candidate.normalized.includes(surface.normalized) ||
      (surface.token && candidate.token && surface.token === candidate.token)
    );
    if (direct) return direct.id;
  }

  const channels = runtimeChannelHints.get(runtime.agentId);
  if (channels?.has("slack") && surfaces.some((surface) => surface.id === "slack-bridge")) {
    return "slack-bridge";
  }
  if (channels?.has("chronos") && surfaces.some((surface) => surface.id === "chronos-mirror-v2")) {
    return "chronos-mirror-v2";
  }
  if (channels?.has("voice") && surfaces.some((surface) => surface.id === "voice-hub")) {
    return "voice-hub";
  }

  return null;
}

export function buildRuntimeTopology(input: {
  surfaces?: RuntimeTopologySurface[];
  runtimes: RuntimeTopologyRuntime[];
  handoffs: A2AHandoffSummary[];
  messages: AgentMessageSummary[];
}): RuntimeTopologySnapshot {
  const owners = new Map<string, RuntimeTopologyOwner>();
  const runtimeActivity = new Map<string, number>();
  const runtimeIds = new Set(input.runtimes.map((runtime) => runtime.agentId));
  const flows = new Map<string, RuntimeTopologyFlow>();
  const runtimeChannelHints = new Map<string, Set<string>>();

  for (const runtime of input.runtimes) {
    const ownerKey = `${runtime.ownerType}:${runtime.ownerId}`;
    const current = owners.get(ownerKey) || {
      id: runtime.ownerId,
      type: runtime.ownerType,
      runtimeCount: 0,
      runtimeIds: [],
    };
    current.runtimeCount += 1;
    current.runtimeIds.push(runtime.agentId);
    owners.set(ownerKey, current);
    runtimeActivity.set(runtime.agentId, 0);
  }

  for (const message of input.messages) {
    if (runtimeIds.has(message.agentId)) {
      runtimeActivity.set(message.agentId, (runtimeActivity.get(message.agentId) || 0) + 1);
      if (message.channel) {
        const current = runtimeChannelHints.get(message.agentId) || new Set<string>();
        current.add(message.channel);
        runtimeChannelHints.set(message.agentId, current);
      }
    }
    const ownerNode = `${message.ownerType}:${message.ownerId}`;
    const flowId = `agent:${ownerNode}:${message.agentId}`;
    const existing = flows.get(flowId);
    flows.set(flowId, {
      id: flowId,
      from: ownerNode,
      to: message.agentId,
      count: (existing?.count || 0) + 1,
      latestAt: existing?.latestAt && existing.latestAt > message.ts ? existing.latestAt : message.ts,
      channel: message.channel,
      thread: message.thread,
      kind: "agent_message",
    });
  }

  for (const handoff of input.handoffs) {
    const flowId = `a2a:${handoff.sender}:${handoff.receiver}`;
    const existing = flows.get(flowId);
    flows.set(flowId, {
      id: flowId,
      from: handoff.sender,
      to: handoff.receiver,
      count: (existing?.count || 0) + 1,
      latestAt: existing?.latestAt && existing.latestAt > handoff.ts ? existing.latestAt : handoff.ts,
      channel: handoff.channel,
      thread: handoff.thread,
      kind: "a2a",
    });
    if (runtimeIds.has(handoff.sender)) {
      runtimeActivity.set(handoff.sender, (runtimeActivity.get(handoff.sender) || 0) + 1);
      if (handoff.channel) {
        const current = runtimeChannelHints.get(handoff.sender) || new Set<string>();
        current.add(handoff.channel);
        runtimeChannelHints.set(handoff.sender, current);
      }
    }
    if (runtimeIds.has(handoff.receiver)) {
      runtimeActivity.set(handoff.receiver, (runtimeActivity.get(handoff.receiver) || 0) + 1);
      if (handoff.channel) {
        const current = runtimeChannelHints.get(handoff.receiver) || new Set<string>();
        current.add(handoff.channel);
        runtimeChannelHints.set(handoff.receiver, current);
      }
    }
  }

  for (const runtime of input.runtimes) {
    const surfaceId = inferRuntimeSurfaceId(runtime, input.surfaces || [], runtimeChannelHints);
    if (!surfaceId) continue;
    const flowId = `surface:${surfaceId}:${runtime.agentId}`;
    const existing = flows.get(flowId);
    flows.set(flowId, {
      id: flowId,
      from: `surface-runtime:${surfaceId}`,
      to: runtime.agentId,
      count: existing?.count || 1,
      latestAt: existing?.latestAt || "",
      kind: "surface_link",
    });
  }

  return {
    surfaces: (input.surfaces || []).sort((a, b) => a.id.localeCompare(b.id)),
    owners: Array.from(owners.values()).sort((a, b) => a.id.localeCompare(b.id)),
    runtimes: input.runtimes
      .map((runtime) => ({
        ...runtime,
        recentActivityCount: runtimeActivity.get(runtime.agentId) || 0,
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    flows: Array.from(flows.values())
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt))
      .slice(0, 18),
  };
}

export function buildRuntimeTopologyGraph(snapshot: RuntimeTopologySnapshot): RuntimeTopologyGraph {
  const surfaceColumn = snapshot.surfaces.map((surface) => ({
    id: `surface-runtime:${surface.id}`,
    label: surface.id,
    kind: "surface" as const,
    detail: `${surface.kind} · ${surface.running ? "running" : "offline"}`,
  }));
  const ownerLookup = new Map(snapshot.owners.map((owner) => [`${owner.type}:${owner.id}`, owner] as const));
  const runtimeColumn = snapshot.runtimes.map((runtime) => ({
    id: runtime.agentId,
    label: runtime.agentId,
    kind: "runtime" as const,
    detail: `${runtime.status} · ${runtime.ownerType}:${runtime.ownerId} · activity ${runtime.recentActivityCount}`,
  }));

  const graphFlows = snapshot.flows.filter((flow) => {
    if (flow.kind === "surface_link") return true;
    if (flow.kind === "a2a") return true;
    if (flow.kind === "agent_message") {
      return !ownerLookup.has(flow.from);
    }
    return true;
  });

  const knownNodeIds = new Set<string>([
    ...surfaceColumn.map((node) => node.id),
    ...runtimeColumn.map((node) => node.id),
  ]);
  const peerIds = Array.from(new Set(
    graphFlows.flatMap((flow) => [flow.from, flow.to]).filter((id) => !knownNodeIds.has(id)),
  )).sort((a, b) => a.localeCompare(b));
  const peerColumn = peerIds.map((peerId) => ({
    id: peerId,
    label: peerId.includes(":") ? peerId.split(":").slice(-1)[0] : peerId,
    kind: "peer" as const,
    detail: "flow endpoint",
  }));

  const columns = [surfaceColumn, runtimeColumn, peerColumn] as const;
  const columnX = [72, 314, 556] as const;
  const rowHeight = 86;
  const topPadding = 56;
  const bottomPadding = 40;
  const maxRows = Math.max(1, ...columns.map((column) => column.length));

  const nodes = columns.flatMap((column, columnIndex) =>
    column.map((node, rowIndex) => ({
      ...node,
      column: columnIndex as 0 | 1 | 2,
      x: columnX[columnIndex],
      y: topPadding + rowIndex * rowHeight,
    })),
  );

  return {
    width: 708,
    height: topPadding + bottomPadding + Math.max(0, maxRows - 1) * rowHeight,
    nodes,
    edges: graphFlows.map((flow) => ({
      id: flow.id,
      from: flow.from,
      to: flow.to,
      kind: flow.kind,
      count: flow.count,
      latestAt: flow.latestAt,
    })),
  };
}
