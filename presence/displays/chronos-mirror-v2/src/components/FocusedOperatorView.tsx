"use client";

import { useEffect, useMemo, useState } from "react";

import { findLatestMissionHandoff, type MissionAssetCategory } from "../lib/mission-progress";
import { buildAttentionItems } from "../lib/operator-console";
import { buildRuntimeTopologyGraph } from "../lib/runtime-topology";
import { resolveChronosLocale, uxText } from "../lib/ux-vocabulary";

type FocusedViewId =
  | "needs-attention"
  | "mission-control-plane"
  | "runtime-topology-map"
  | "runtime-lease-doctor"
  | "recent-surface-outbox"
  | "owner-summaries";

interface Payload {
  activeMissions: Array<{
    missionId: string;
    tier: string;
    missionType?: string;
    nextTaskCount: number;
    controlSummary: string;
    controlTone: "planning" | "ready" | "attention" | "pending";
  }>;
  missionProgress: Array<{
    missionId: string;
    boardStatus: string;
    boardStepsTotal: number;
    boardStepsDone: number;
    boardStepsActive: number;
    boardStepsPending: number;
    nextTasksTotal: number;
    nextTasksPending: number;
    nextTasksCompleted: number;
    dependencies: string[];
    generatedAssets: Array<{
      path: string;
      category: MissionAssetCategory;
      sizeBytes: number;
      updatedAt: string;
    }>;
  }>;
  a2aHandoffs: Array<{
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
  }>;
  runtimeDoctor: Array<{
    severity: "warning" | "critical";
    agentId: string;
    ownerId: string;
    reason: string;
    recommendedAction: "stop_runtime" | "restart_runtime";
  }>;
  surfaces: Array<{
    id: string;
    health: string;
    controlSummary: string;
    controlTone: "stable" | "attention" | "offline" | "pending";
  }>;
  recentSurfaceOutbox: Array<{
    message_id: string;
    surface: "slack" | "chronos";
    channel: string;
    text: string;
    created_at: string;
  }>;
  runtimeTopology: {
    surfaces: Array<{
      id: string;
      kind: string;
      running: boolean;
      startupMode?: string;
      pid?: number;
    }>;
    owners: Array<{ id: string; type: string; runtimeCount: number; runtimeIds: string[] }>;
    runtimes: Array<{
      agentId: string;
      provider: string;
      modelId?: string;
      status: string;
      ownerId: string;
      ownerType: string;
      requestedBy?: string;
      leaseKind?: string;
      pid?: number;
      recentActivityCount: number;
    }>;
    flows: Array<{
      id: string;
      from: string;
      to: string;
      count: number;
      latestAt: string;
      kind: "a2a" | "agent_message" | "surface_link";
      channel?: string;
      thread?: string;
    }>;
  };
  runtime?: {
    total: number;
    ready: number;
    busy: number;
    error: number;
  };
  ownerSummaries: Array<{
    ts: string;
    mission_id: string;
    accepted_count: number;
    reviewed_count: number;
    completed_count: number;
    requested_count: number;
  }>;
  recentEvents: Array<{
    ts: string;
    decision: string;
    mission_id?: string;
    why?: string;
  }>;
}

const TITLES: Record<FocusedViewId, string> = {
  "needs-attention": "Needs Attention",
  "mission-control-plane": "Mission Control",
  "runtime-topology-map": "Runtime Topology",
  "runtime-lease-doctor": "Runtime Governance",
  "recent-surface-outbox": "Delivery Exceptions",
  "owner-summaries": "Audit Trail",
};

const ASSET_FILTERS: Array<{ id: "all" | MissionAssetCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "deliverables", label: "Deliverables" },
  { id: "artifacts", label: "Artifacts" },
  { id: "outputs", label: "Outputs" },
  { id: "evidence", label: "Evidence" },
];

const EMPTY_PAYLOAD: Payload = {
  activeMissions: [],
  missionProgress: [],
  a2aHandoffs: [],
  runtimeDoctor: [],
  surfaces: [],
  recentSurfaceOutbox: [],
  runtimeTopology: {
    surfaces: [],
    owners: [],
    runtimes: [],
    flows: [],
  },
  runtime: {
    total: 0,
    ready: 0,
    busy: 0,
    error: 0,
  },
  ownerSummaries: [],
  recentEvents: [],
};

function normalizePayload(input: Partial<Payload> | null | undefined): Payload {
  return {
    ...EMPTY_PAYLOAD,
    ...input,
    activeMissions: Array.isArray(input?.activeMissions) ? input.activeMissions : EMPTY_PAYLOAD.activeMissions,
    missionProgress: Array.isArray(input?.missionProgress) ? input.missionProgress : EMPTY_PAYLOAD.missionProgress,
    a2aHandoffs: Array.isArray(input?.a2aHandoffs) ? input.a2aHandoffs : EMPTY_PAYLOAD.a2aHandoffs,
    runtimeDoctor: Array.isArray(input?.runtimeDoctor) ? input.runtimeDoctor : EMPTY_PAYLOAD.runtimeDoctor,
    surfaces: Array.isArray(input?.surfaces) ? input.surfaces : EMPTY_PAYLOAD.surfaces,
    recentSurfaceOutbox: Array.isArray(input?.recentSurfaceOutbox) ? input.recentSurfaceOutbox : EMPTY_PAYLOAD.recentSurfaceOutbox,
    runtimeTopology: {
      ...EMPTY_PAYLOAD.runtimeTopology,
      ...(input?.runtimeTopology || {}),
      surfaces: Array.isArray(input?.runtimeTopology?.surfaces) ? input.runtimeTopology.surfaces : EMPTY_PAYLOAD.runtimeTopology.surfaces,
      owners: Array.isArray(input?.runtimeTopology?.owners) ? input.runtimeTopology.owners : EMPTY_PAYLOAD.runtimeTopology.owners,
      runtimes: Array.isArray(input?.runtimeTopology?.runtimes) ? input.runtimeTopology.runtimes : EMPTY_PAYLOAD.runtimeTopology.runtimes,
      flows: Array.isArray(input?.runtimeTopology?.flows) ? input.runtimeTopology.flows : EMPTY_PAYLOAD.runtimeTopology.flows,
    },
    runtime: input?.runtime ? { ...EMPTY_PAYLOAD.runtime, ...input.runtime } : EMPTY_PAYLOAD.runtime,
    ownerSummaries: Array.isArray(input?.ownerSummaries) ? input.ownerSummaries : EMPTY_PAYLOAD.ownerSummaries,
    recentEvents: Array.isArray(input?.recentEvents) ? input.recentEvents : EMPTY_PAYLOAD.recentEvents,
  };
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function graphNodePalette(kind: "surface" | "runtime" | "peer"): { fill: string; stroke: string } {
  if (kind === "surface") return { fill: "#31214d", stroke: "#c39cff" };
  if (kind === "runtime") return { fill: "#183425", stroke: "#88f0b2" };
  return { fill: "#362818", stroke: "#f0c78a" };
}

const RUNTIME_GRAPH_NODE_WIDTH = 156;
const RUNTIME_GRAPH_NODE_HEIGHT = 40;

export function FocusedOperatorView({
  viewId,
  onBack,
}: {
  viewId: FocusedViewId;
  onBack: () => void;
}) {
  const locale = resolveChronosLocale();
  const ft = (key: string, fallbackEn: string) => uxText(key, fallbackEn, locale);
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<"all" | MissionAssetCategory>("all");
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/intelligence", { cache: "no-store" });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(body.error || "Failed to load operator view");
          return;
        }
        setData(normalizePayload(body));
        setError(null);
      } catch (err: any) {
        if (alive) setError(err.message || "Failed to load operator view");
      }
    };
    load();
    const timer = setInterval(load, 15000);
    const source = new EventSource("/api/intelligence/stream");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as Partial<Payload>;
        if (!alive) return;
        setData((current) => current ? normalizePayload({
          ...current,
          recentEvents: Array.isArray(payload.recentEvents) ? payload.recentEvents : current.recentEvents,
          a2aHandoffs: Array.isArray(payload.a2aHandoffs) ? payload.a2aHandoffs : current.a2aHandoffs,
          ownerSummaries: Array.isArray(payload.ownerSummaries) ? payload.ownerSummaries : current.ownerSummaries,
          runtimeTopology: payload.runtimeTopology || current.runtimeTopology,
          runtime: payload.runtime || current.runtime,
        }) : current);
      } catch {
        // Ignore malformed SSE payloads and rely on polling fallback.
      }
    };
    source.onerror = () => {
      source.close();
    };
    return () => {
      alive = false;
      clearInterval(timer);
      source.close();
    };
  }, [viewId]);

  const attentionItems = useMemo(() => {
    if (!data) return [];
    return buildAttentionItems({
      missions: data.activeMissions,
      runtimeDoctor: data.runtimeDoctor,
      surfaces: data.surfaces,
      outbox: data.recentSurfaceOutbox.map((entry) => ({
        message_id: entry.message_id,
        surface: entry.surface,
        text: entry.text,
      })),
    });
  }, [data]);
  const runtimeGraph = useMemo(() => {
    if (!data) {
      return buildRuntimeTopologyGraph({
        surfaces: [],
        owners: [],
        runtimes: [],
        flows: [],
      });
    }
    return buildRuntimeTopologyGraph(data.runtimeTopology);
  }, [data]);
  const selectedFlow = useMemo(
    () => data?.runtimeTopology.flows.find((flow) => flow.id === selectedFlowId) || null,
    [data, selectedFlowId],
  );

  if (!mounted) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-black/20 px-5 py-5 text-[11px] uppercase tracking-[0.22em] text-white/40">
        Loading focused operator view...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[24px] border border-red-500/20 bg-red-950/10 px-5 py-5">
        <div className="text-[10px] uppercase tracking-[0.28em] text-red-300/70">Focused Operator View</div>
        <div className="mt-2 text-sm text-red-100/80">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-black/20 px-5 py-5 text-[11px] uppercase tracking-[0.22em] text-white/40">
        Loading focused operator view...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[24px] border border-cyan-300/12 bg-cyan-400/[0.06] px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/58">Focused Operator View</div>
            <div className="mt-2 text-xl font-semibold tracking-tight text-white/90">{TITLES[viewId]}</div>
            <div className="mt-1 text-[11px] leading-5 text-white/58">
              {ft("chronos_focused_view_hint", "This mode isolates one operator concern so you can inspect it without the rest of the control surface competing for attention.")}
            </div>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="self-start rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-white/75 transition hover:bg-white/10"
          >
            Show Full Console
          </button>
        </div>
      </section>

      {viewId === "needs-attention" && (
        <div className="grid gap-3">
          {attentionItems.length === 0 ? (
            <div className="rounded-2xl border border-emerald-300/10 bg-emerald-400/[0.04] px-4 py-4 text-[11px] text-emerald-100/70">
              No immediate operator intervention is recommended.
            </div>
          ) : attentionItems.map((item) => (
            <div key={item.id} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">{item.title}</div>
              <div className="mt-2 text-sm text-white/82">{item.reason}</div>
              <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-white/38">{item.targetType}</div>
            </div>
          ))}
        </div>
      )}

      {viewId === "mission-control-plane" && (
        <div className="grid gap-3">
          {data.activeMissions.map((mission) => (
            (() => {
              const progress = data.missionProgress.find((entry) => entry.missionId === mission.missionId);
              return (
                <div key={mission.missionId} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold text-white/90">{mission.missionId}</div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">{mission.controlSummary}</div>
                  </div>
                  <div className="mt-2 text-[10px] text-white/55">
                    {mission.missionType || "development"} · {mission.tier}
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-[0.95fr,1.05fr]">
                    <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">task board</div>
                      <div className="mt-2 text-sm text-white/86">{progress?.boardStatus || "Unknown"}</div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                        <div>steps total <span className="font-mono text-white/82">{progress?.boardStepsTotal ?? 0}</span></div>
                        <div>done <span className="font-mono text-white/82">{progress?.boardStepsDone ?? 0}</span></div>
                        <div>active <span className="font-mono text-white/82">{progress?.boardStepsActive ?? 0}</span></div>
                        <div>pending <span className="font-mono text-white/82">{progress?.boardStepsPending ?? 0}</span></div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">next tasks</div>
                      <div className="mt-2 text-sm text-white/86">{mission.nextTaskCount} visible in current queue</div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                        <div>queue total <span className="font-mono text-white/82">{progress?.nextTasksTotal ?? mission.nextTaskCount}</span></div>
                        <div>pending <span className="font-mono text-white/82">{progress?.nextTasksPending ?? mission.nextTaskCount}</span></div>
                        <div>completed <span className="font-mono text-white/82">{progress?.nextTasksCompleted ?? 0}</span></div>
                        <div>control <span className="font-mono text-white/82">{mission.controlTone}</span></div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">dependencies</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(progress?.dependencies || []).length === 0 ? (
                          <span className="text-[10px] text-white/38">No declared prerequisites.</span>
                        ) : (progress?.dependencies || []).map((dependency) => (
                          <span key={dependency} className="rounded-full border border-white/8 bg-black/20 px-2 py-1 text-[9px] font-mono text-white/62">
                            {dependency}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">generated assets</div>
                        <div className="flex flex-wrap justify-end gap-1">
                          {ASSET_FILTERS.map((filter) => (
                            <button
                              key={filter.id}
                              type="button"
                              onClick={() => setAssetFilter(filter.id)}
                              className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.14em] transition ${
                                assetFilter === filter.id
                                  ? "border-cyan-300/30 bg-cyan-300/12 text-cyan-50"
                                  : "border-white/8 bg-black/20 text-white/45 hover:bg-white/10"
                              }`}
                            >
                              {filter.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2">
                        {(progress?.generatedAssets || []).filter((asset) => assetFilter === "all" || asset.category === assetFilter).length === 0 ? (
                          <span className="text-[10px] text-white/38">No generated assets discovered yet.</span>
                        ) : (progress?.generatedAssets || [])
                          .filter((asset) => assetFilter === "all" || asset.category === assetFilter)
                          .map((asset) => (
                          <div key={asset.path} className="rounded-lg border border-white/6 bg-black/20 px-3 py-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-[9px] uppercase tracking-[0.16em] text-white/38">{asset.category}</div>
                              <a
                                href={`/api/mission-asset?missionId=${encodeURIComponent(mission.missionId)}&path=${encodeURIComponent(asset.path)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[9px] uppercase tracking-[0.16em] text-cyan-100/72 underline decoration-cyan-200/30 underline-offset-2"
                              >
                                open
                              </a>
                            </div>
                            <div className="mt-1 break-all font-mono text-[10px] text-white/74">{asset.path}</div>
                            <div className="mt-1 flex flex-wrap gap-3 text-[9px] text-white/42">
                              <span>{formatBytes(asset.sizeBytes)}</span>
                              <span>{formatTimestamp(asset.updatedAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">latest handoff</div>
                    {(() => {
                      const latestHandoff = findLatestMissionHandoff(mission.missionId, data.a2aHandoffs);
                      if (!latestHandoff) {
                        return <div className="mt-2 text-[10px] text-white/38">No recent A2A handoff recorded for this mission.</div>;
                      }
                      return (
                        <div className="mt-2 rounded-lg border border-white/6 bg-black/20 px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-[10px] text-white/80">
                              {latestHandoff.sender} → {latestHandoff.receiver}
                            </div>
                            <div className="text-[9px] text-white/38">{formatTimestamp(latestHandoff.ts)}</div>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-3 text-[9px] text-white/45">
                            <span>{latestHandoff.performative || "handoff"}</span>
                            {latestHandoff.intent ? <span>{latestHandoff.intent}</span> : null}
                            {latestHandoff.channel ? <span>{latestHandoff.channel}</span> : null}
                          </div>
                          <div className="mt-2 text-[10px] leading-5 text-white/68">
                            {latestHandoff.promptExcerpt || "No prompt excerpt was captured for the latest handoff."}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })()
          ))}
        </div>
      )}

      {viewId === "runtime-topology-map" && (
        <div className="grid gap-4">
          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">runtime graph</div>
                <div className="mt-2 text-[11px] leading-5 text-white/56">
                  Surface runtimes sit on the left, managed agent runtimes in the center, and external peers or unresolved flow endpoints on the right. Ownership stays attached to each runtime card instead of becoming a separate node.
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[9px] uppercase tracking-[0.14em] text-white/52">
                <span className="rounded-full border border-[#c39cff]/30 bg-[#31214d]/70 px-2 py-1">surface</span>
                <span className="rounded-full border border-[#88f0b2]/30 bg-[#183425]/70 px-2 py-1">runtime</span>
                <span className="rounded-full border border-[#f0c78a]/30 bg-[#362818]/70 px-2 py-1">peer</span>
              </div>
            </div>
            {runtimeGraph.nodes.length === 0 ? (
              <div className="mt-4 text-[10px] text-white/35">No managed owners or runtime flow observed yet.</div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="overflow-x-auto rounded-xl border border-white/6 bg-white/[0.03] p-3">
                <svg
                  viewBox={`0 0 ${runtimeGraph.width} ${runtimeGraph.height}`}
                  className="min-w-[720px]"
                  role="img"
                  aria-label="Runtime topology graph"
                >
                  {runtimeGraph.edges.map((edge) => {
                    const fromNode = runtimeGraph.nodes.find((node) => node.id === edge.from);
                    const toNode = runtimeGraph.nodes.find((node) => node.id === edge.to);
                    if (!fromNode || !toNode) return null;
                    const stroke = edge.kind === "a2a" ? "#6bc7ff" : edge.kind === "surface_link" ? "#c39cff" : "#88f0b2";
                    const fromX = fromNode.x - 12;
                    const toX = toNode.x - 12;
                    const fromAnchorX = fromX + RUNTIME_GRAPH_NODE_WIDTH;
                    const toAnchorX = toX;
                    const anchorY = 20;
                    return (
                      <g key={edge.id}>
                        <path
                          d={`M ${fromAnchorX} ${fromNode.y + anchorY} C ${fromAnchorX + 28} ${fromNode.y + anchorY}, ${toAnchorX - 28} ${toNode.y + anchorY}, ${toAnchorX} ${toNode.y + anchorY}`}
                          fill="none"
                          stroke={stroke}
                          strokeOpacity={selectedFlowId === edge.id ? "0.95" : "0.55"}
                          strokeWidth={selectedFlowId === edge.id ? Math.min(6, 2 + edge.count * 0.45) : Math.min(4, 1 + edge.count * 0.35)}
                          className="cursor-pointer"
                          onMouseEnter={() => setSelectedFlowId(edge.id)}
                          onClick={() => setSelectedFlowId(edge.id)}
                        />
                        <text
                          x={(fromAnchorX + toAnchorX) / 2}
                          y={Math.min(fromNode.y, toNode.y) + 12}
                          textAnchor="middle"
                          fill="#d6e8f5"
                          fontSize="9"
                          opacity="0.55"
                        >
                          {edge.kind} · {edge.count}
                        </text>
                      </g>
                    );
                  })}
                  {runtimeGraph.nodes.map((node) => {
                    const palette = graphNodePalette(node.kind);
                    return (
                      <g key={node.id} transform={`translate(${node.x - 12} ${node.y})`}>
                        <rect
                          width={RUNTIME_GRAPH_NODE_WIDTH}
                          height={RUNTIME_GRAPH_NODE_HEIGHT}
                          rx="12"
                          fill={palette.fill}
                          stroke={palette.stroke}
                          strokeWidth="1.1"
                          fillOpacity="0.9"
                        />
                        <text x="12" y="16" fill="#f4f7fb" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, monospace">
                          {node.label}
                        </text>
                        <text x="12" y="30" fill="#b7c7d8" fontSize="8.5" opacity="0.8">
                          {node.detail}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                </div>
                <div className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">selected flow</div>
                  {!selectedFlow ? (
                    <div className="mt-2 text-[10px] leading-5 text-white/38">
                      Hover or click an edge to inspect its direction, recent count, and latest activity timestamp.
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      <div className="font-mono text-[10px] text-white/82">
                        {selectedFlow.from} → {selectedFlow.to}
                      </div>
                      <div className="flex flex-wrap gap-2 text-[9px] uppercase tracking-[0.14em] text-white/48">
                        <span>{selectedFlow.kind}</span>
                        <span>count {selectedFlow.count}</span>
                      </div>
                      <div className="text-[10px] text-white/55">
                        latest activity: <span className="font-mono text-white/74">{formatTimestamp(selectedFlow.latestAt)}</span>
                      </div>
                      {selectedFlow.channel ? (
                        <div className="text-[10px] text-white/50">
                          channel: <span className="font-mono text-white/70">{selectedFlow.channel}</span>
                        </div>
                      ) : null}
                      {selectedFlow.thread ? (
                        <div className="text-[10px] text-white/50">
                          thread: <span className="font-mono text-white/70">{selectedFlow.thread}</span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">surface runtimes</div>
              <div className="mt-3 space-y-2">
                {data.runtimeTopology.surfaces.length === 0 ? (
                  <div className="text-[10px] text-white/35">No surfaces registered for topology.</div>
                ) : data.runtimeTopology.surfaces.map((surface) => (
                  <div key={surface.id} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                    <div className="text-[10px] font-mono text-white/78">{surface.id}</div>
                    <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                      {surface.kind} · {surface.running ? "running" : "offline"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">owners</div>
              <div className="mt-3 space-y-2">
                {data.runtimeTopology.owners.length === 0 ? (
                  <div className="text-[10px] text-white/35">No managed owners discovered.</div>
                ) : data.runtimeTopology.owners.map((owner) => (
                  <div key={`${owner.type}:${owner.id}`} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                    <div className="text-[10px] font-mono text-white/78">{owner.id}</div>
                    <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                      {owner.type} · runtimes {owner.runtimeCount}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-4 lg:col-span-2">
              <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">managed runtimes</div>
                <div className="mt-3 space-y-2">
                  {data.runtimeTopology.runtimes.length === 0 ? (
                    <div className="text-[10px] text-white/35">No managed runtimes discovered.</div>
                  ) : data.runtimeTopology.runtimes.map((runtime) => (
                    <div key={runtime.agentId} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-mono text-white/80">{runtime.agentId}</div>
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white/38">{runtime.status}</div>
                      </div>
                      <div className="mt-1 text-[9px] text-white/48">{runtime.ownerType}:{runtime.ownerId} · activity {runtime.recentActivityCount}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">recent flow</div>
                <div className="mt-3 space-y-2">
                  {data.runtimeTopology.flows.length === 0 ? (
                    <div className="text-[10px] text-white/35">No recent flow observed.</div>
                  ) : data.runtimeTopology.flows.map((flow) => (
                    <div key={flow.id} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                      <div className="text-[10px] font-mono text-white/80">{flow.from} → {flow.to}</div>
                      <div className="mt-1 text-[9px] text-white/45">{flow.kind} · count {flow.count}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {viewId === "runtime-lease-doctor" && (
        <div className="grid gap-3">
          {data.runtimeDoctor.length === 0 ? (
            <div className="rounded-2xl border border-emerald-300/10 bg-emerald-400/[0.04] px-4 py-4 text-[11px] text-emerald-100/70">
              No stale or orphaned runtime leases detected.
            </div>
          ) : data.runtimeDoctor.map((finding) => (
            <div key={finding.agentId} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] font-mono text-white/80">{finding.agentId}</div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-white/38">{finding.severity}</div>
              </div>
              <div className="mt-2 text-sm text-white/80">{finding.reason}</div>
            </div>
          ))}
        </div>
      )}

      {viewId === "recent-surface-outbox" && (
        <div className="grid gap-3">
          {data.recentSurfaceOutbox.length === 0 ? (
            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4 text-[11px] text-white/50">
              No pending or recent surface outbox messages.
            </div>
          ) : data.recentSurfaceOutbox.map((message) => (
            <div key={message.message_id} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">{message.surface} · {message.channel}</div>
                <div className="text-[9px] text-white/35">{new Date(message.created_at).toLocaleString()}</div>
              </div>
              <div className="mt-2 text-sm text-white/82">{message.text}</div>
            </div>
          ))}
        </div>
      )}

      {viewId === "owner-summaries" && (
        <div className="grid gap-4 lg:grid-cols-[0.95fr,1.05fr]">
          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">owner summaries</div>
            <div className="mt-3 space-y-2">
              {data.ownerSummaries.map((summary) => (
                <div key={`${summary.mission_id}-${summary.ts}`} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                  <div className="text-[10px] font-mono text-white/80">{summary.mission_id}</div>
                  <div className="mt-1 text-[9px] text-white/45">
                    accepted {summary.accepted_count} · reviewed {summary.reviewed_count} · completed {summary.completed_count}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">recent events</div>
            <div className="mt-3 space-y-2">
              {data.recentEvents.map((event, index) => (
                <div key={`${event.ts}-${index}`} className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-3">
                  <div className="text-[10px] font-mono text-white/80">{event.decision}</div>
                  <div className="mt-1 text-[9px] text-white/45">{event.mission_id || "system"}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
