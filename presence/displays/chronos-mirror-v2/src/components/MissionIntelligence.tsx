"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Activity, AlertTriangle, Bot, GitBranch, Radar, Send, ShieldAlert } from "lucide-react";
import { buildAttentionItems, type AttentionItem } from "../lib/operator-console";
import type { RuntimeTopologySnapshot } from "../lib/runtime-topology";
import { resolveChronosLocale, uxText } from "../lib/ux-vocabulary";

interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  planReady: boolean;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: "planning" | "ready" | "attention" | "pending";
  controlRequestedBy?: string;
}

interface OrchestrationEvent {
  ts: string;
  decision: string;
  mission_id?: string;
  why?: string;
}

interface RuntimeSummary {
  total: number;
  ready: number;
  busy: number;
  error: number;
}

interface RuntimeLease {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  metadata?: Record<string, unknown>;
}

interface RuntimeDoctorFinding {
  severity: "warning" | "critical";
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: "stop_runtime" | "restart_runtime";
}

interface OwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

interface SurfaceOutboxMessage {
  message_id: string;
  surface: "slack" | "chronos";
  correlation_id: string;
  channel: string;
  thread_ts: string;
  text: string;
  source: "surface" | "nerve" | "system";
  created_at: string;
}

interface BrowserSessionSummary {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  last_trace_path?: string;
  lease_expires_at?: string;
  lease_status: "active" | "released" | "expired";
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: "control" | "capture" | "apply";
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

interface AgentMessageSummary {
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

interface A2AHandoffSummary {
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

interface MissionThreadEntry {
  ts: string;
  missionId: string;
  type: "handoff" | "prompt" | "agent" | "stderr";
  tone: "request" | "response" | "runtime";
  agentId: string;
  teamRole?: string;
  label: string;
  content: string;
  channel?: string;
  thread?: string;
}

interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: "mission" | "surface";
  target: string;
  operation: string;
  status: "queued" | "completed" | "failed";
  requested_by: string;
  error?: string;
}

interface ControlActionDetail {
  ts: string;
  decision: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  operation?: string;
  why?: string;
  error?: string;
}

interface ControlActionDefinition {
  operation: string;
  label: string;
  risk: "safe" | "risky";
  approvalRequired: boolean;
  enabled: boolean;
  disabledReason?: string;
}

interface ControlActionCatalog {
  mission: ControlActionDefinition[];
  surface: ControlActionDefinition[];
  globalSurface: ControlActionDefinition[];
}

interface ControlActionAvailability {
  mission: Record<string, ControlActionDefinition[]>;
  surface: Record<string, ControlActionDefinition[]>;
  globalSurface: ControlActionDefinition[];
}

function getLatestMissionControlAction(
  actions: ControlActionSummary[],
  missionId: string,
): ControlActionSummary | null {
  return actions.find((action) => action.kind === "mission" && action.target === missionId) || null;
}

function getLatestSurfaceControlAction(
  actions: ControlActionSummary[],
  surfaceId: string,
): ControlActionSummary | null {
  return actions.find((action) => action.kind === "surface" && action.target === surfaceId) || null;
}

function getGlobalSurfaceControlAction(
  actions: ControlActionSummary[],
): ControlActionSummary | null {
  return actions.find((action) => action.kind === "surface" && action.target === "surface-runtime") || null;
}

function toDomId(prefix: "mission" | "surface", value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function ActionStatusBadge({ action }: { action: ControlActionSummary }) {
  return (
    <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.22em] ${
      action.status === "completed"
        ? "bg-green-500/15 text-green-300"
        : action.status === "failed"
          ? "bg-red-500/15 text-red-300"
          : "bg-yellow-500/10 text-yellow-200"
    }`}>
      {action.operation} · {action.status}
    </div>
  );
}

function messageToneClass(tone: AgentMessageSummary["tone"]): string {
  if (tone === "request") return "border-cyan-300/15 bg-cyan-400/8 text-cyan-100/80";
  if (tone === "response") return "border-emerald-300/15 bg-emerald-400/8 text-emerald-100/80";
  return "border-amber-300/15 bg-amber-400/8 text-amber-100/80";
}

function messageTypeLabel(type: AgentMessageSummary["type"]): string {
  if (type === "handoff") return "a2a handoff";
  return type;
}

function buildMissionThread(
  missionId: string,
  agentMessages: AgentMessageSummary[],
  a2aHandoffs: A2AHandoffSummary[],
): MissionThreadEntry[] {
  const entries: MissionThreadEntry[] = [];

  for (const handoff of a2aHandoffs) {
    if (handoff.missionId !== missionId) continue;
    entries.push({
      ts: handoff.ts,
      missionId,
      type: "handoff",
      tone: "request",
      agentId: handoff.receiver,
      teamRole: handoff.teamRole,
      label: `${handoff.sender} -> ${handoff.receiver}`,
      content: handoff.promptExcerpt || "A2A handoff dispatched.",
      channel: handoff.channel,
      thread: handoff.thread,
    });
  }

  for (const message of agentMessages) {
    if (message.missionId !== missionId) continue;
    entries.push({
      ts: message.ts,
      missionId,
      type: message.type,
      tone: message.tone,
      agentId: message.agentId,
      teamRole: message.teamRole,
      label: message.agentId,
      content: message.content,
      channel: message.channel,
      thread: message.thread,
    });
  }

  return entries.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-48);
}

function ActionDetailList({
  actionId,
  details,
}: {
  actionId?: string;
  details: Record<string, ControlActionDetail[]>;
}) {
  if (!actionId) return null;
  const entries = details[actionId] || [];
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-white/6 bg-black/25 px-3 py-3">
      {entries.length === 0 ? (
        <div className="text-[10px] text-white/40">No detail observations recorded yet.</div>
      ) : entries.map((detail, detailIndex) => (
        <div key={`${actionId}-${detail.ts}-${detailIndex}`} className="border-l border-white/10 pl-3">
          <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
            {detail.decision}
          </div>
          {detail.why && <div className="mt-1 text-[10px] text-white/60">{detail.why}</div>}
          {detail.error && <div className="mt-1 text-[10px] text-red-200/70">{detail.error}</div>}
          <div className="mt-1 text-[9px] font-mono text-white/25">{new Date(detail.ts).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function ActionGuidance({
  latestAction,
  availableActions,
}: {
  latestAction: ControlActionSummary | null;
  availableActions: ControlActionDefinition[];
}) {
  if (!latestAction) return null;
  const currentAction = getActionDefinition(availableActions, latestAction.operation);
  const nextValidActions = availableActions.filter((action) => action.enabled && action.operation !== latestAction.operation);
  const shouldShow =
    latestAction.status === "failed" ||
    Boolean(currentAction?.disabledReason) ||
    nextValidActions.length > 0;

  if (!shouldShow) return null;

  return (
    <div className="mt-3 rounded-lg border border-white/6 bg-black/25 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">operator guidance</div>
      {currentAction?.disabledReason && (
        <div className="mt-2 text-[10px] text-white/55">
          disabled reason: <span className="text-white/75">{currentAction.disabledReason}</span>
        </div>
      )}
      {nextValidActions.length > 0 && (
        <div className="mt-2 text-[10px] text-white/55">
          next valid actions:{" "}
          <span className="text-white/75">{nextValidActions.map((action) => action.label).join(", ")}</span>
        </div>
      )}
      {latestAction.status === "failed" && nextValidActions.length === 0 && !currentAction?.enabled && (
        <div className="mt-2 text-[10px] text-amber-200/75">
          No immediate retry path is available from the current target state.
        </div>
      )}
    </div>
  );
}

function actionButtonClass(kind: "safe" | "risky"): string {
  if (kind === "risky") {
    return "rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40";
  }
  return "rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
}

function missionSummaryBadgeClass(tone: MissionSummary["controlTone"]): string {
  if (tone === "pending") return "bg-violet-500/15 text-violet-200";
  if (tone === "ready") return "bg-cyan-500/15 text-cyan-200";
  if (tone === "attention") return "bg-yellow-500/10 text-yellow-200";
  return "bg-green-500/15 text-green-300";
}

function surfaceSummaryBadgeClass(tone: SurfaceSummary["controlTone"]): string {
  if (tone === "pending") return "bg-violet-500/15 text-violet-200";
  if (tone === "stable") return "bg-green-500/15 text-green-300";
  if (tone === "offline") return "bg-white/10 text-white/65";
  return "bg-yellow-500/10 text-yellow-200";
}

interface IntelligencePayload {
  accessRole: "readonly" | "localadmin";
  activeMissions: MissionSummary[];
  surfaces: SurfaceSummary[];
  recentEvents: OrchestrationEvent[];
  agentMessages: AgentMessageSummary[];
  a2aHandoffs: A2AHandoffSummary[];
  controlActionCatalog: ControlActionCatalog;
  controlActionAvailability: ControlActionAvailability;
  controlActions: ControlActionSummary[];
  controlActionDetails: Record<string, ControlActionDetail[]>;
  ownerSummaries: OwnerSummary[];
  browserSessions: BrowserSessionSummary[];
  browserConversationSessions: Array<{
    session_id: string;
    surface: string;
    status: string;
    mode: string;
    updated_at: string;
    goal_summary: string;
    active_step?: string;
    pending_confirmation: boolean;
    candidate_target_count: number;
  }>;
  surfaceOutbox: {
    slack: number;
    chronos: number;
  };
  recentSurfaceOutbox: SurfaceOutboxMessage[];
  runtime: RuntimeSummary;
  runtimeLeases: RuntimeLease[];
  runtimeDoctor: RuntimeDoctorFinding[];
  runtimeTopology: RuntimeTopologySnapshot;
}

function getActionsByRisk(
  actions: ControlActionDefinition[],
  risk: "safe" | "risky",
): ControlActionDefinition[] {
  return actions.filter((action) => action.risk === risk);
}

function getSharedDisabledReason(actions: ControlActionDefinition[]): string | null {
  const reasons = actions
    .map((action) => action.disabledReason)
    .filter((reason): reason is string => Boolean(reason));
  return reasons[0] || null;
}

function getAvailableMissionActions(data: IntelligencePayload, missionId: string): ControlActionDefinition[] {
  return data.controlActionAvailability.mission[missionId] || data.controlActionCatalog.mission;
}

function getAvailableSurfaceActions(data: IntelligencePayload, surfaceId: string): ControlActionDefinition[] {
  return data.controlActionAvailability.surface[surfaceId] || data.controlActionCatalog.surface;
}

function getActionDefinition(
  actions: ControlActionDefinition[],
  operation: string,
): ControlActionDefinition | null {
  return actions.find((action) => action.operation === operation) || null;
}

interface SurfaceSummary {
  id: string;
  kind: string;
  startupMode?: string;
  enabled: boolean;
  running: boolean;
  pid?: number;
  health: string;
  detail?: string;
  controlSummary: string;
  controlTone: "stable" | "attention" | "offline" | "pending";
  controlRequestedBy?: string;
}

export function MissionIntelligence({
  focusedView = null,
  onClearFocus,
}: {
  focusedView?: string | null;
  onClearFocus?: () => void;
}) {
  const locale = resolveChronosLocale();
  const mt = (key: string, fallbackEn: string) => uxText(key, fallbackEn, locale);
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remediationTarget, setRemediationTarget] = useState<string | null>(null);
  const [outboxTarget, setOutboxTarget] = useState<string | null>(null);
  const [missionActionTarget, setMissionActionTarget] = useState<string | null>(null);
  const [surfaceActionTarget, setSurfaceActionTarget] = useState<string | null>(null);
  const [browserSessionTarget, setBrowserSessionTarget] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  const [expandedMissionCardActionId, setExpandedMissionCardActionId] = useState<string | null>(null);
  const [expandedSurfaceCardActionId, setExpandedSurfaceCardActionId] = useState<string | null>(null);
  const [expandedGlobalSurfaceActionId, setExpandedGlobalSurfaceActionId] = useState<string | null>(null);
  const [messageMissionFilter, setMessageMissionFilter] = useState<string>("all");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const mission = params.get("mission");
    if (!mission) return;
    setSelectedMissionId(mission);
    setMessageMissionFilter(mission);
  }, []);

  const jumpToTarget = (action: ControlActionSummary) => {
    const id = action.kind === "mission"
      ? toDomId("mission", action.target)
      : toDomId("surface", action.target);
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const refreshData = async () => {
    const refreshed = await fetch("/api/intelligence", { cache: "no-store" });
    const refreshedBody = await refreshed.json();
    if (!refreshed.ok) {
      throw new Error(refreshedBody.error || "Failed to refresh mission intelligence");
    }
    setData(refreshedBody);
    setError(null);
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/intelligence", { cache: "no-store" });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(body.error || "Failed to load mission intelligence");
          return;
        }
        setData(body);
      } catch (err: any) {
        if (alive) setError(err.message || "Failed to load mission intelligence");
      }
    };

    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/intelligence/stream");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          recentEvents?: OrchestrationEvent[];
          agentMessages?: AgentMessageSummary[];
          a2aHandoffs?: A2AHandoffSummary[];
          controlActions?: ControlActionSummary[];
          controlActionDetails?: Record<string, ControlActionDetail[]>;
          ownerSummaries?: OwnerSummary[];
          browserSessions?: BrowserSessionSummary[];
          runtime?: {
            total: number;
            ready: number;
            busy: number;
            error: number;
          };
          runtimeTopology?: MissionIntelligenceProps["data"]["runtimeTopology"];
        };
        setData((current) => current ? {
          ...current,
          recentEvents: Array.isArray(payload.recentEvents) ? payload.recentEvents : current.recentEvents,
          agentMessages: Array.isArray(payload.agentMessages) ? payload.agentMessages : current.agentMessages,
          a2aHandoffs: Array.isArray(payload.a2aHandoffs) ? payload.a2aHandoffs : current.a2aHandoffs,
          controlActions: Array.isArray(payload.controlActions) ? payload.controlActions : current.controlActions,
          controlActionDetails: payload.controlActionDetails || current.controlActionDetails,
          ownerSummaries: Array.isArray(payload.ownerSummaries) ? payload.ownerSummaries : current.ownerSummaries,
          browserSessions: Array.isArray(payload.browserSessions) ? payload.browserSessions : current.browserSessions,
          runtime: payload.runtime || current.runtime,
          runtimeTopology: payload.runtimeTopology || current.runtimeTopology,
        } : current);
      } catch {
        // Ignore malformed SSE payloads and keep polling fallback.
      }
    };

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, []);

  const remediateLease = async (agentId: string, action: "cleanup_runtime_lease" | "restart_runtime_lease") => {
    try {
      setRemediationTarget(agentId);
      const res = await fetch("/api/intelligence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          agentId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to remediate runtime lease");
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || "Failed to remediate runtime lease");
    } finally {
      setRemediationTarget(null);
    }
  };

  const clearOutboxMessage = async (surface: "slack" | "chronos", messageId: string) => {
    try {
      setOutboxTarget(messageId);
      const res = await fetch("/api/intelligence", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "clear_surface_outbox",
          surface,
          messageId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to clear outbox message");
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || "Failed to clear outbox message");
    } finally {
      setOutboxTarget(null);
    }
  };

  const runMissionControl = async (missionId: string, operation: string) => {
    try {
      setMissionActionTarget(`${missionId}:${operation}`);
      const res = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mission_control",
          missionId,
          operation,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Mission control action failed");
      setActionResult(`${missionId}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || "Mission control action failed");
    } finally {
      setMissionActionTarget(null);
    }
  };

  const runSurfaceControl = async (surfaceId: string | null, operation: string) => {
    try {
      setSurfaceActionTarget(`${surfaceId || "all"}:${operation}`);
      const res = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "surface_control",
          surfaceId,
          operation,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Surface control action failed");
      setActionResult(`${surfaceId || "surfaces"}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || "Surface control action failed");
    } finally {
      setSurfaceActionTarget(null);
    }
  };

  const runBrowserSessionControl = async (sessionId: string, action: "close_browser_session" | "restart_browser_session") => {
    try {
      setBrowserSessionTarget(`${sessionId}:${action}`);
      const res = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          sessionId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Browser session control action failed");
      setActionResult(`${sessionId}: ${action}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || "Browser session control action failed");
    } finally {
      setBrowserSessionTarget(null);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selectedMissionId) {
      url.searchParams.set("mission", selectedMissionId);
    } else {
      url.searchParams.delete("mission");
    }
    window.history.replaceState({}, "", url.toString());
  }, [selectedMissionId]);

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="rounded-2xl border border-red-500/20 bg-red-950/10 px-6 py-5 text-center">
          <div className="text-[11px] uppercase tracking-[0.25em] text-red-300/70">Mission Intelligence</div>
          <div className="mt-2 text-sm text-red-200/80">{error}</div>
        </div>
      </div>
    );
  }

  if (!mounted) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-black/20 px-5 py-5 text-[11px] uppercase tracking-[0.22em] text-white/40">
        Loading mission intelligence...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-[11px] uppercase tracking-[0.25em] text-kyberion-gold/40">{mt("chronos_mission_loading", "Loading mission intelligence...")}</div>
      </div>
    );
  }

  const filteredAgentMessages = messageMissionFilter === "all"
    ? data.agentMessages
    : data.agentMessages.filter((message) => message.missionId === messageMissionFilter);
  const filteredA2AHandoffs = messageMissionFilter === "all"
    ? data.a2aHandoffs
    : data.a2aHandoffs.filter((handoff) => handoff.missionId === messageMissionFilter);
  const effectiveMissionId = selectedMissionId || (messageMissionFilter !== "all" ? messageMissionFilter : data.activeMissions[0]?.missionId) || null;
  const missionThread = effectiveMissionId
    ? buildMissionThread(effectiveMissionId, data.agentMessages, data.a2aHandoffs)
    : [];
  const missionExceptions = data.activeMissions.filter((mission) => mission.controlTone === "attention" || mission.controlTone === "pending");
  const surfaceExceptions = data.surfaces.filter((surface) => surface.controlTone === "attention" || surface.health === "unhealthy");
  const deliveryExceptions = data.recentSurfaceOutbox;
  const attentionItems = buildAttentionItems({
    missions: data.activeMissions,
    runtimeDoctor: data.runtimeDoctor,
    surfaces: data.surfaces,
    outbox: data.recentSurfaceOutbox,
  });

  const runAttentionAction = (item: AttentionItem) => {
    if (item.targetType === "mission") {
      setSelectedMissionId(item.targetId);
      setMessageMissionFilter(item.targetId);
      document.getElementById(toDomId("mission", item.targetId))?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (item.targetType === "runtime" && item.remediationAction) {
      remediateLease(item.targetId, item.remediationAction);
      return;
    }
    if (item.targetType === "surface") {
      document.getElementById(toDomId("surface", item.targetId))?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    document.getElementById("recent-surface-outbox")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const showAllViews = focusedView == null;
  const isVisible = (sectionId: string) => showAllViews || focusedView === sectionId;
  const focusTitle = focusedView
    ? ({
        "needs-attention": "Needs Attention",
        "mission-control-plane": "Mission Control",
        "runtime-topology-map": "Runtime Topology",
        "runtime-lease-doctor": "Runtime Governance",
        "recent-surface-outbox": "Delivery Exceptions",
        "owner-summaries": "Audit Trail",
      } as Record<string, string>)[focusedView] || "Focused View"
    : null;

  return (
    <div className="w-full h-full flex flex-col gap-6 overflow-y-auto pr-1">
      {focusedView && (
        <section className="rounded-[24px] border border-cyan-300/12 bg-cyan-400/[0.06] px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/58">Focused Operator View</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/90">{focusTitle}</div>
              <div className="mt-1 text-[11px] leading-5 text-white/58">
                The main console is showing one operator view at full width.
              </div>
            </div>
            {onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                className="self-start rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-white/75 transition hover:bg-white/10"
              >
                Show Full Console
              </button>
            )}
          </div>
        </section>
      )}
      <section className="rounded-[26px] border border-kyberion-gold/15 bg-gradient-to-br from-kyberion-gold/10 via-black/10 to-cyan-950/20 px-5 py-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-kyberion-gold/45">{mt("chronos_operator_console", "Operator Console")}</div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white/90">
              {mt("chronos_mission_hero_title", "Start with exceptions, then intervene only where mission flow or runtime governance needs help.")}
            </h2>
            <p className="mt-2 max-w-3xl text-[12px] leading-6 text-white/52">
              {mt("chronos_mission_hero_description", "Chronos is the operational mirror for Kyberion. Confirm what is active, identify what is blocked, open A2UI drill-downs when you need detail, and keep control actions deliberate and minimal.")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[10px] uppercase tracking-[0.18em] text-white/48 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>needs attention</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">{attentionItems.length}</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>missions</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">{data.activeMissions.length}</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>runtime incidents</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">{data.runtimeDoctor.length}</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>delivery queue</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">
                {data.surfaceOutbox.slack + data.surfaceOutbox.chronos}
              </div>
            </div>
          </div>
        </div>
        {actionResult && (
          <div className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-400/8 px-3 py-2 text-[11px] text-cyan-100/80">
            {mt("chronos_last_action", "last action")}: {actionResult}
          </div>
        )}
        <div className="mt-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-[11px] text-white/60">
          {mt("chronos_access", "access")}: <span className="font-mono text-white/85">{data.accessRole}</span>
          {data.accessRole === "readonly"
            ? mt("chronos_control_actions_disabled", " · control actions are disabled until a localadmin token is provided or localhost auto-admin is enabled.")
            : mt("chronos_control_actions_enabled", " · control actions enabled.")}
        </div>
        <div className="mt-3 rounded-xl border border-amber-200/10 bg-stone-100/[0.035] px-3 py-3 text-[11px] leading-5 text-stone-100/68">
          Surfaces are the explainable boundary between people and agent execution. Chronos is the control surface: it should clarify mission flow, runtime risk, and intervention points before it offers controls.
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          icon={<ShieldAlert size={14} />}
          label={mt("chronos_attention_queue", "Needs Attention")}
          value={String(attentionItems.length)}
          detail={mt("chronos_attention_queue_detail", "Mission blockers, runtime incidents, and delivery exceptions")}
        />
        <MetricCard
          icon={<Bot size={14} />}
          label="Runtime Governance"
          value={`${data.runtimeDoctor.length}/${data.runtimeLeases.length}`}
          detail={`ready=${data.runtime.ready} busy=${data.runtime.busy} error=${data.runtime.error}`}
        />
        <MetricCard
          icon={<Send size={14} />}
          label={mt("chronos_delivery_exceptions", "Delivery Exceptions")}
          value={String(data.surfaceOutbox.slack + data.surfaceOutbox.chronos)}
          detail={mt("chronos_delivery_exceptions_detail", "Outbox entries awaiting operator attention")}
        />
      </div>

      <section className="grid gap-4">
        <Panel id="needs-attention" title="Needs Attention">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Start here. These are the items most likely to block mission progress or degrade operator trust. Use the action only when the control plane does not self-heal.
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.15fr,0.85fr]">
            <div className="space-y-3">
              {attentionItems.length === 0 ? (
                <div className="rounded-xl border border-emerald-300/10 bg-emerald-400/[0.04] px-4 py-3 text-[11px] text-emerald-100/70">
                  No immediate operator intervention is recommended. Stay in observe mode and use A2UI drill-downs for detail.
                </div>
              ) : attentionItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border px-4 py-3 ${
                    item.tone === "critical"
                      ? "border-red-400/20 bg-red-950/12"
                      : item.tone === "warning"
                        ? "border-amber-300/18 bg-amber-400/[0.06]"
                        : "border-cyan-300/16 bg-cyan-400/[0.06]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                      {item.tone === "critical" ? "critical" : item.tone === "warning" ? "warning" : "info"}
                    </div>
                    <div className="text-[10px] font-mono text-white/40">{item.title}</div>
                  </div>
                  <div className="mt-2 text-[11px] text-white/78">{item.reason}</div>
                    {item.actionLabel && (
                      <button
                        type="button"
                        onClick={() => runAttentionAction(item)}
                        className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/75 transition hover:bg-white/10"
                      >
                        {item.actionLabel}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <MiniSummaryCard icon={<GitBranch size={13} />} label="Mission blockers" value={missionExceptions.length} detail="Missions needing operator attention" />
              <MiniSummaryCard icon={<Bot size={13} />} label="Runtime incidents" value={data.runtimeDoctor.length} detail="Leases or runtimes flagged by doctor" />
              <MiniSummaryCard icon={<Radar size={13} />} label="Surface incidents" value={surfaceExceptions.length} detail="Managed surfaces needing review" />
              <MiniSummaryCard icon={<Send size={13} />} label="Delivery exceptions" value={deliveryExceptions.length} detail="Outbox entries or delivery residue" />
            </div>
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr,1fr,1fr]">
        <Panel id="mission-control-plane" title="Mission Control">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Confirm which missions are active, which ones are blocked, and what the next safe intervention is. Pinning a mission narrows the unified thread below without leaving the operator console.
          </div>
          <div className="space-y-3">
            {data.activeMissions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No active missions.</div>
            ) : data.activeMissions.map((mission) => {
              const missionActions = getAvailableMissionActions(data, mission.missionId);
              const safeMissionActions = getActionsByRisk(missionActions, "safe");
              const riskyMissionActions = getActionsByRisk(missionActions, "risky");
              const safeDisabledReason = getSharedDisabledReason(safeMissionActions);
              const riskyDisabledReason = getSharedDisabledReason(riskyMissionActions);
              return (
              <div
                id={toDomId("mission", mission.missionId)}
                key={mission.missionId}
                className={`rounded-xl border bg-black/20 px-4 py-3 ${effectiveMissionId === mission.missionId ? "border-cyan-300/20 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]" : "border-white/5"}`}
              >
                {(() => {
                  const latestAction = getLatestMissionControlAction(data.controlActions, mission.missionId);
                  return latestAction ? (
                    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                        last control action
                      </div>
                      <ActionStatusBadge action={latestAction} />
                    </div>
                  ) : null;
                })()}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">{mission.missionId}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/35">
                      {mission.missionType || "development"} · {mission.tier}
                    </div>
                  </div>
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                    mission.planReady ? "bg-green-500/15 text-green-300" : "bg-yellow-500/10 text-yellow-200"
                  }`}>
                    {mission.planReady ? "plan ready" : mission.status}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${missionSummaryBadgeClass(mission.controlTone)}`}>
                    {mission.controlSummary}
                  </div>
                  <div className="text-[10px] text-white/45">control summary</div>
                  {mission.controlRequestedBy && (
                    <div className="text-[10px] text-white/35">
                      requested by <span className="font-mono text-white/60">{mission.controlRequestedBy}</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                  <div>
                    next tasks: <span className="font-mono text-white/80">{mission.nextTaskCount}</span>
                  </div>
                  <div>
                    plan: <span className="font-mono text-white/80">{mission.planReady ? "ready" : "pending"}</span>
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMissionId(mission.missionId);
                      setMessageMissionFilter(mission.missionId);
                    }}
                    className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                  >
                    {effectiveMissionId === mission.missionId ? "mission pinned" : "pin mission thread"}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(() => {
                    const latestAction = getLatestMissionControlAction(data.controlActions, mission.missionId);
                    const retryAction = latestAction ? getActionDefinition(missionActions, latestAction.operation) : null;
                    if (!latestAction?.event_id) return null;
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpandedMissionCardActionId((current) => current === latestAction.event_id ? null : latestAction.event_id || null)}
                          className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                        >
                          {expandedMissionCardActionId === latestAction.event_id ? "hide latest action" : "show latest action"}
                        </button>
                        {latestAction.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => runMissionControl(mission.missionId, latestAction.operation)}
                            disabled={!retryAction?.enabled || missionActionTarget === `${mission.missionId}:${latestAction.operation}`}
                            title={retryAction?.disabledReason}
                            className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {missionActionTarget === `${mission.missionId}:${latestAction.operation}` ? "retrying" : "retry latest action"}
                          </button>
                        )}
                      </>
                    );
                  })()}
                  <div className="flex flex-wrap gap-2 rounded-lg border border-emerald-300/10 bg-emerald-400/[0.04] px-2 py-2">
                    <div className="w-full text-[9px] uppercase tracking-[0.18em] text-emerald-200/50">safe actions</div>
                    {safeMissionActions.map((action) => (
                      <button
                        key={action.operation}
                        type="button"
                        onClick={() => runMissionControl(mission.missionId, action.operation)}
                        disabled={!action.enabled || missionActionTarget === `${mission.missionId}:${action.operation}`}
                        title={action.disabledReason}
                        className={actionButtonClass("safe")}
                      >
                        {missionActionTarget === `${mission.missionId}:${action.operation}` ? "working" : action.label}
                      </button>
                    ))}
                    {safeDisabledReason && (
                      <div className="w-full text-[10px] text-white/40">
                        {safeDisabledReason}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 rounded-lg border border-red-300/10 bg-red-400/[0.04] px-2 py-2">
                    <div className="w-full text-[9px] uppercase tracking-[0.18em] text-red-200/50">risky actions · approval required</div>
                    {riskyMissionActions.map((action) => (
                      <button
                        key={action.operation}
                        type="button"
                        onClick={() => runMissionControl(mission.missionId, action.operation)}
                        disabled={!action.enabled || missionActionTarget === `${mission.missionId}:${action.operation}`}
                        title={action.disabledReason}
                        className={actionButtonClass("risky")}
                      >
                        {missionActionTarget === `${mission.missionId}:${action.operation}` ? "working" : action.label}
                      </button>
                    ))}
                    {riskyDisabledReason && (
                      <div className="w-full text-[10px] text-white/40">
                        {riskyDisabledReason}
                      </div>
                    )}
                  </div>
                </div>
                {(() => {
                  const latestAction = getLatestMissionControlAction(data.controlActions, mission.missionId);
                  return latestAction?.event_id && expandedMissionCardActionId === latestAction.event_id ? (
                    <>
                      <ActionDetailList actionId={latestAction.event_id} details={data.controlActionDetails} />
                      <ActionGuidance latestAction={latestAction} availableActions={missionActions} />
                    </>
                  ) : null;
                })()}
              </div>
              );
            })}
          </div>
        </Panel>

        <Panel id="runtime-topology-map" title="Runtime Topology Map">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            This map shows what the supervisor daemon is currently holding: who owns each runtime, which runtimes are active, and which agent-to-agent or owner-to-agent flows were seen recently.
          </div>
          <div className="grid gap-3">
            <div className="grid gap-3 lg:grid-cols-[0.9fr,1.1fr]">
              <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">owners</div>
                <div className="space-y-2">
                  {data.runtimeTopology.owners.length === 0 ? (
                    <div className="text-[10px] text-white/35">No managed owners discovered.</div>
                  ) : data.runtimeTopology.owners.map((owner) => (
                    <div key={`${owner.type}:${owner.id}`} className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                      <div className="text-[10px] font-mono text-white/78">{owner.id}</div>
                      <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                        {owner.type} · runtimes {owner.runtimeCount}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {owner.runtimeIds.map((runtimeId) => (
                          <span key={runtimeId} className="rounded-full border border-white/8 bg-black/20 px-2 py-1 text-[9px] font-mono text-white/58">
                            {runtimeId}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">managed runtimes</div>
                <div className="space-y-2">
                  {data.runtimeTopology.runtimes.length === 0 ? (
                    <div className="text-[10px] text-white/35">No managed runtimes discovered.</div>
                  ) : data.runtimeTopology.runtimes.map((runtime) => (
                    <div key={runtime.agentId} className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-mono text-white/82">{runtime.agentId}</div>
                        <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${
                          runtime.status === "ready"
                            ? "bg-green-500/15 text-green-300"
                            : runtime.status === "busy"
                              ? "bg-amber-400/12 text-amber-100"
                              : runtime.status === "error"
                                ? "bg-red-500/15 text-red-300"
                                : "bg-white/10 text-white/65"
                        }`}>
                          {runtime.status}
                        </div>
                      </div>
                      <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                        {runtime.provider}{runtime.modelId ? `/${runtime.modelId}` : ""} · {runtime.ownerType}:{runtime.ownerId}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-white/42">
                        {runtime.leaseKind && <span>lease {runtime.leaseKind}</span>}
                        {runtime.requestedBy && <span>requested by {runtime.requestedBy}</span>}
                        {typeof runtime.pid === "number" && <span>pid {runtime.pid}</span>}
                        <span>activity {runtime.recentActivityCount}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">recent flow</div>
              <div className="space-y-2">
                {data.runtimeTopology.flows.length === 0 ? (
                  <div className="text-[10px] text-white/35">No recent A2A or agent-message flow observed.</div>
                ) : data.runtimeTopology.flows.map((flow) => (
                  <div key={flow.id} className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] font-mono text-white/80">{flow.from} → {flow.to}</div>
                      <div className="text-[9px] uppercase tracking-[0.16em] text-white/38">{flow.kind}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[9px] text-white/42">
                      <span>count {flow.count}</span>
                      {flow.channel && <span>channel {flow.channel}</span>}
                      {flow.thread && <span>thread {flow.thread}</span>}
                      <span>{new Date(flow.latestAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        <Panel id="runtime-lease-doctor" title="Runtime Governance">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Managed runtimes are part of operations, not a separate playground. Use this section to resolve stale leases, errored runtimes, and ownership drift without over-restarting healthy agents.
          </div>
          <div className="space-y-3">
            {data.runtimeDoctor.length === 0 ? (
              <div className="text-[11px] italic text-emerald-300/40">No stale or orphaned runtime leases detected.</div>
            ) : data.runtimeDoctor.map((finding, index) => (
              <div key={`${finding.agentId}-${index}`} className={`rounded-xl border px-3 py-3 ${
                finding.severity === "critical"
                  ? "border-red-500/20 bg-red-950/10"
                  : "border-yellow-500/20 bg-yellow-950/10"
              }`}>
                <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em]">
                  <span className={finding.severity === "critical" ? "text-red-300/80" : "text-yellow-200/80"}>
                    {finding.severity}
                  </span>
                  <span className="font-mono text-white/45">{finding.agentId}</span>
                </div>
                <div className="mt-2 text-[10px] text-white/65">owner: {finding.ownerId}</div>
                <div className="mt-1 text-[10px] text-white/55">{finding.reason}</div>
                <button
                  type="button"
                  onClick={() => remediateLease(
                    finding.agentId,
                    finding.recommendedAction === "restart_runtime" ? "restart_runtime_lease" : "cleanup_runtime_lease",
                  )}
                  disabled={remediationTarget === finding.agentId}
                  className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {remediationTarget === finding.agentId
                    ? "remediating"
                    : finding.recommendedAction === "restart_runtime"
                      ? "restart runtime"
                      : "stop runtime"}
                </button>
              </div>
            ))}

            <div className="border-t border-white/5 pt-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/35">Managed Runtime Leases</div>
              <div className="space-y-2">
                {data.runtimeLeases.slice(0, 6).map((lease) => (
                  <div key={`${lease.agent_id}-${lease.owner_id}`} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                    <div className="text-[10px] font-mono text-white/75">{lease.agent_id}</div>
                    <div className="mt-1 text-[10px] text-white/45">
                      {lease.owner_type}: {lease.owner_id}
                    </div>
                    {typeof lease.metadata?.team_role === "string" && (
                      <div className="mt-1 text-[10px] text-white/35">team_role: {lease.metadata.team_role}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        <Panel id="recent-surface-outbox" title="Delivery Exceptions">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Outbox items are operator-facing delivery residue. Resolve them here only when the autonomous path has already stalled or a human-visible queue needs cleanup.
          </div>
          <div className="space-y-3">
            {data.recentSurfaceOutbox.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">{mt("chronos_no_recent_surface_outbox", "No pending or recent surface outbox messages.")}</div>
            ) : data.recentSurfaceOutbox.map((message) => (
              <div key={message.message_id} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                    {message.surface} · {message.source} · {message.channel}
                  </div>
                  <div className="text-[9px] font-mono text-white/30">{new Date(message.created_at).toLocaleString()}</div>
                </div>
                <div className="mt-2 text-[9px] uppercase tracking-[0.18em] text-white/28">
                  {mt("chronos_correlation", "correlation")}: {message.correlation_id}
                </div>
                <div className="mt-2 text-[11px] text-white/80">{message.text}</div>
                <button
                  type="button"
                  onClick={() => clearOutboxMessage(message.surface, message.message_id)}
                  disabled={outboxTarget === message.message_id}
                  className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {outboxTarget === message.message_id ? mt("chronos_clearing", "clearing") : mt("chronos_clear_outbox", "clear outbox")}
                </button>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel title="Recent Control Actions">
          <div className="space-y-3">
            {data.controlActions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No recent mission or surface control actions.</div>
            ) : data.controlActions.map((action, index) => (
              <div key={`${action.event_id || action.ts}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                    {action.kind} · {action.operation}
                  </div>
                  <ActionStatusBadge action={action} />
                </div>
                <div className="mt-2 text-[11px] text-white/80">{action.target}</div>
                <div className="mt-1 text-[10px] text-white/45">
                  requested_by: <span className="font-mono text-white/70">{action.requested_by}</span>
                </div>
                {action.event_id && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedActionId((current) => current === action.event_id ? null : action.event_id || null)}
                      className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10"
                    >
                      {expandedActionId === action.event_id ? "hide details" : "show details"}
                    </button>
                    {action.target !== "surface-runtime" && (
                      <button
                        type="button"
                        onClick={() => jumpToTarget(action)}
                        className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                      >
                        jump to target
                      </button>
                    )}
                  </div>
                )}
                {action.event_id && expandedActionId === action.event_id && (
                  <ActionDetailList actionId={action.event_id} details={data.controlActionDetails} />
                )}
                {action.error && (
                  <div className="mt-2 text-[10px] text-red-200/70">{action.error}</div>
                )}
                <div className="mt-2 text-[9px] font-mono text-white/25">{new Date(action.ts).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </Panel>
      </section>
      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel title="Orchestration Audit">
          <div className="space-y-3">
            {data.recentEvents.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No orchestration events yet.</div>
            ) : data.recentEvents.map((event, index) => (
              <div key={`${event.ts}-${index}`} className="border-l border-kyberion-gold/20 pl-3">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-white/45">
                  <Activity size={10} />
                  <span>{event.decision}</span>
                </div>
                <div className="mt-1 text-[11px] text-white/80">{event.mission_id || "system"}</div>
                {event.why && <div className="mt-1 text-[10px] text-white/45">{event.why}</div>}
                <div className="mt-1 text-[9px] font-mono text-white/25">{new Date(event.ts).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel id="owner-summaries" title="Owner Summaries">
          <div className="space-y-3">
            {data.ownerSummaries.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No owner summaries yet.</div>
            ) : data.ownerSummaries.map((summary, index) => (
              <div key={`${summary.mission_id}-${summary.ts}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">{summary.mission_id}</div>
                  <div className="text-[9px] font-mono text-white/30">{new Date(summary.ts).toLocaleString()}</div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/60">
                  <div>accepted: <span className="font-mono text-white/80">{summary.accepted_count}</span></div>
                  <div>reviewed: <span className="font-mono text-white/80">{summary.reviewed_count}</span></div>
                  <div>completed: <span className="font-mono text-white/80">{summary.completed_count}</span></div>
                  <div>requested: <span className="font-mono text-white/80">{summary.requested_count}</span></div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel id="runtime-summary" title="Operator Summary">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/48">
            Keep the operator loop narrow: look at exceptions first, then mission readiness, then runtime and delivery counters. When these stay green, use quick actions to open governed A2UI drill-downs rather than adding more controls here.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <RuntimeCell label="ready" value={data.runtime.ready} accent="emerald" />
            <RuntimeCell label="busy" value={data.runtime.busy} accent="gold" />
            <RuntimeCell label="error" value={data.runtime.error} accent="red" />
            <RuntimeCell label="leases" value={data.runtimeLeases.length} accent="cyan" />
            <RuntimeCell label="slack outbox" value={data.surfaceOutbox.slack} accent="gold" />
            <RuntimeCell label="chronos outbox" value={data.surfaceOutbox.chronos} accent="cyan" />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
        <Panel id="browser-sessions" title="Browser Session Oversight">
          <div className="space-y-3">
            {data.browserSessions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No browser sessions recorded yet.</div>
            ) : data.browserSessions.map((session) => (
              <div key={session.session_id} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">{session.session_id}</div>
                    <div className="mt-1 text-[10px] text-white/45">
                      active tab: <span className="font-mono text-white/70">{session.active_tab_id}</span> · tabs: <span className="font-mono text-white/70">{session.tab_count}</span>
                    </div>
                  </div>
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                    session.lease_status === "active"
                      ? "bg-cyan-500/15 text-cyan-200"
                      : session.lease_status === "expired"
                        ? "bg-yellow-500/10 text-yellow-200"
                        : "bg-white/10 text-white/65"
                  }`}>
                    {session.lease_status}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                  <div>retained: <span className="font-mono text-white/80">{String(session.retained)}</span></div>
                  <div>trail: <span className="font-mono text-white/80">{session.action_trail_count}</span></div>
                  <div>updated: <span className="font-mono text-white/80">{new Date(session.updated_at).toLocaleTimeString()}</span></div>
                  <div>
                    lease expires: <span className="font-mono text-white/80">{session.lease_expires_at ? new Date(session.lease_expires_at).toLocaleTimeString() : "n/a"}</span>
                  </div>
                </div>
                {session.last_trace_path && (
                  <div className="mt-2 text-[10px] text-white/40">
                    trace: <span className="font-mono text-white/60">{session.last_trace_path}</span>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => runBrowserSessionControl(session.session_id, "close_browser_session")}
                    disabled={browserSessionTarget === `${session.session_id}:close_browser_session` || session.lease_status !== "active"}
                    className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {browserSessionTarget === `${session.session_id}:close_browser_session` ? "closing" : "close session"}
                  </button>
                  <button
                    type="button"
                    onClick={() => runBrowserSessionControl(session.session_id, "restart_browser_session")}
                    disabled={browserSessionTarget === `${session.session_id}:restart_browser_session`}
                    className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {browserSessionTarget === `${session.session_id}:restart_browser_session` ? "restarting" : "restart session"}
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">recent browser trail</div>
                  {session.recent_actions.length === 0 ? (
                    <div className="text-[10px] text-white/35">No recorded browser actions.</div>
                  ) : session.recent_actions.map((action, index) => (
                    <div key={`${session.session_id}-${action.ts}-${index}`} className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-white/55">
                          {action.kind} · {action.op}
                        </div>
                        <div className="text-[9px] font-mono text-white/30">{new Date(action.ts).toLocaleTimeString()}</div>
                      </div>
                      <div className="mt-1 text-[10px] text-white/45">
                        {action.tab_id && <span className="mr-2">tab: <span className="font-mono text-white/65">{action.tab_id}</span></span>}
                        {action.ref && <span className="mr-2">ref: <span className="font-mono text-white/65">{action.ref}</span></span>}
                        {action.selector && <span>selector: <span className="font-mono text-white/55">{action.selector}</span></span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Browser Guidance">
          <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/50">
            Browser sessions stay fast only while they are leased. Prefer `snapshot + ref`, then export recorded trails as Playwright specs in either strict or hint mode.
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <RuntimeCell label="browser sessions" value={data.browserSessions.length} accent="cyan" />
            <RuntimeCell label="active leases" value={data.browserSessions.filter((session) => session.lease_status === "active").length} accent="emerald" />
            <RuntimeCell label="retained" value={data.browserSessions.filter((session) => session.retained).length} accent="gold" />
            <RuntimeCell label="expired" value={data.browserSessions.filter((session) => session.lease_status === "expired").length} accent="red" />
          </div>
        </Panel>
        <Panel id="browser-conversation-sessions" title="Browser Conversation Sessions">
          <div className="space-y-3">
            {data.browserConversationSessions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No browser conversation sessions recorded yet.</div>
            ) : data.browserConversationSessions.map((session) => (
              <div key={session.session_id} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">{session.session_id}</div>
                    <div className="mt-1 text-[10px] text-white/45">
                      surface: <span className="font-mono text-white/70">{session.surface}</span> · mode: <span className="font-mono text-white/70">{session.mode}</span>
                    </div>
                  </div>
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                    session.status === "completed"
                      ? "bg-green-500/15 text-green-300"
                      : session.status === "awaiting_confirmation"
                        ? "bg-yellow-500/10 text-yellow-200"
                        : session.status === "failed"
                          ? "bg-red-500/15 text-red-200"
                          : "bg-cyan-500/15 text-cyan-200"
                  }`}>
                    {session.status}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                  <div>goal: <span className="text-white/80">{session.goal_summary || "n/a"}</span></div>
                  <div>step: <span className="text-white/80">{session.active_step || "n/a"}</span></div>
                  <div>pending confirm: <span className="font-mono text-white/80">{String(session.pending_confirmation)}</span></div>
                  <div>candidates: <span className="font-mono text-white/80">{session.candidate_target_count}</span></div>
                  <div>updated: <span className="font-mono text-white/80">{new Date(session.updated_at).toLocaleTimeString()}</span></div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel id="surface-control" title="Surface Control">
          <div className="mb-3 flex flex-wrap gap-2">
            {(() => {
              const latestAction = getGlobalSurfaceControlAction(data.controlActions);
              const retryAction = latestAction ? getActionDefinition(data.controlActionAvailability.globalSurface, latestAction.operation) : null;
              return latestAction ? (
                <>
                  <div className="mr-2 flex items-center rounded-lg border border-white/6 bg-white/[0.03] px-3 py-1.5 text-[10px] text-white/55">
                    {mt("chronos_surfaces", "surfaces")}
                    <span className="ml-2">{latestAction.operation}</span>
                    <span className="ml-2"><ActionStatusBadge action={latestAction} /></span>
                  </div>
                  {latestAction.event_id && (
                    <button
                      type="button"
                      onClick={() => setExpandedGlobalSurfaceActionId((current) => current === latestAction.event_id ? null : latestAction.event_id || null)}
                      className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                    >
                      {expandedGlobalSurfaceActionId === latestAction.event_id ? mt("chronos_hide_latest_action", "hide latest action") : mt("chronos_show_latest_action", "show latest action")}
                    </button>
                  )}
                  {latestAction.status === "failed" && (
                    <button
                      type="button"
                      onClick={() => runSurfaceControl(null, latestAction.operation)}
                      disabled={!retryAction?.enabled || surfaceActionTarget === `all:${latestAction.operation}`}
                      title={retryAction?.disabledReason}
                      className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {surfaceActionTarget === `all:${latestAction.operation}` ? mt("chronos_retrying", "retrying") : mt("chronos_retry_latest_action", "retry latest action")}
                    </button>
                  )}
                </>
              ) : null;
            })()}
            {data.controlActionAvailability.globalSurface.map((action) => (
              <button
                key={action.operation}
                type="button"
                onClick={() => runSurfaceControl(null, action.operation)}
                disabled={!action.enabled || surfaceActionTarget === `all:${action.operation}`}
                title={action.disabledReason}
                className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {surfaceActionTarget === `all:${action.operation}` ? "working" : action.label}
              </button>
            ))}
            {getSharedDisabledReason(data.controlActionAvailability.globalSurface) && (
              <div className="w-full text-[10px] text-white/40">
                {getSharedDisabledReason(data.controlActionAvailability.globalSurface)}
              </div>
            )}
          </div>
          {(() => {
            const latestAction = getGlobalSurfaceControlAction(data.controlActions);
            return latestAction?.event_id && expandedGlobalSurfaceActionId === latestAction.event_id ? (
              <div className="mb-3">
                <ActionDetailList actionId={latestAction.event_id} details={data.controlActionDetails} />
                <ActionGuidance latestAction={latestAction} availableActions={data.controlActionAvailability.globalSurface} />
              </div>
            ) : null;
          })()}
          <div className="space-y-3">
            {data.surfaces.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">{mt("chronos_no_managed_surfaces", "No managed surfaces.")}</div>
            ) : data.surfaces.map((surface) => {
              const surfaceActions = getAvailableSurfaceActions(data, surface.id);
              const safeSurfaceActions = getActionsByRisk(surfaceActions, "safe");
              const riskySurfaceActions = getActionsByRisk(surfaceActions, "risky");
              const safeDisabledReason = getSharedDisabledReason(safeSurfaceActions);
              const riskyDisabledReason = getSharedDisabledReason(riskySurfaceActions);
              return (
              <div id={toDomId("surface", surface.id)} key={surface.id} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                {(() => {
                  const latestAction = getLatestSurfaceControlAction(data.controlActions, surface.id);
                  return latestAction ? (
                    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                        {mt("chronos_last_control_action", "last control action")}
                      </div>
                      <ActionStatusBadge action={latestAction} />
                    </div>
                  ) : null;
                })()}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">{surface.id}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/35">
                      {surface.kind} · {surface.startupMode || mt("chronos_background", "background")} · {surface.running ? mt("chronos_running", "running") : mt("chronos_stopped", "stopped")}
                    </div>
                  </div>
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                    surface.health === "healthy"
                      ? "bg-green-500/15 text-green-300"
                      : surface.health === "unhealthy"
                        ? "bg-red-500/15 text-red-300"
                        : "bg-yellow-500/10 text-yellow-200"
                  }`}>
                    {surface.health}
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-white/50">
                  pid: <span className="font-mono text-white/75">{surface.pid ?? "-"}</span>
                  {surface.detail ? <> · {mt("chronos_detail", "detail")}: <span className="font-mono text-white/75">{surface.detail}</span></> : null}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${surfaceSummaryBadgeClass(surface.controlTone)}`}>
                    {surface.controlSummary}
                  </div>
                  <div className="text-[10px] text-white/45">{mt("chronos_control_summary", "control summary")}</div>
                  {surface.controlRequestedBy && (
                    <div className="text-[10px] text-white/35">
                      {mt("chronos_requested_by", "requested by")} <span className="font-mono text-white/60">{surface.controlRequestedBy}</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(() => {
                    const latestAction = getLatestSurfaceControlAction(data.controlActions, surface.id);
                    const retryAction = latestAction ? getActionDefinition(surfaceActions, latestAction.operation) : null;
                    if (!latestAction?.event_id) return null;
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpandedSurfaceCardActionId((current) => current === latestAction.event_id ? null : latestAction.event_id || null)}
                          className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                        >
                          {expandedSurfaceCardActionId === latestAction.event_id ? mt("chronos_hide_latest_action", "hide latest action") : mt("chronos_show_latest_action", "show latest action")}
                        </button>
                        {latestAction.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => runSurfaceControl(surface.id, latestAction.operation)}
                            disabled={!retryAction?.enabled || surfaceActionTarget === `${surface.id}:${latestAction.operation}`}
                            title={retryAction?.disabledReason}
                            className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {surfaceActionTarget === `${surface.id}:${latestAction.operation}` ? mt("chronos_retrying", "retrying") : mt("chronos_retry_latest_action", "retry latest action")}
                          </button>
                        )}
                      </>
                    );
                  })()}
                  <div className="flex flex-wrap gap-2 rounded-lg border border-emerald-300/10 bg-emerald-400/[0.04] px-2 py-2">
                    <div className="w-full text-[9px] uppercase tracking-[0.18em] text-emerald-200/50">{mt("chronos_safe_actions", "safe actions")}</div>
                    {safeSurfaceActions.map((action) => (
                      <button
                        key={action.operation}
                        type="button"
                        onClick={() => runSurfaceControl(surface.id, action.operation)}
                        disabled={!action.enabled || surfaceActionTarget === `${surface.id}:${action.operation}`}
                        title={action.disabledReason}
                        className={actionButtonClass("safe")}
                      >
                        {surfaceActionTarget === `${surface.id}:${action.operation}` ? mt("chronos_working", "working") : action.label}
                      </button>
                    ))}
                    {safeDisabledReason && (
                      <div className="w-full text-[10px] text-white/40">
                        {safeDisabledReason}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 rounded-lg border border-red-300/10 bg-red-400/[0.04] px-2 py-2">
                    <div className="w-full text-[9px] uppercase tracking-[0.18em] text-red-200/50">{mt("chronos_risky_actions_approval_required", "risky actions · approval required")}</div>
                    {riskySurfaceActions.map((action) => (
                      <button
                        key={action.operation}
                        type="button"
                        onClick={() => runSurfaceControl(surface.id, action.operation)}
                        disabled={!action.enabled || surfaceActionTarget === `${surface.id}:${action.operation}`}
                        title={action.disabledReason}
                        className={actionButtonClass("risky")}
                      >
                        {surfaceActionTarget === `${surface.id}:${action.operation}` ? mt("chronos_working", "working") : action.label}
                      </button>
                    ))}
                    {riskyDisabledReason && (
                      <div className="w-full text-[10px] text-white/40">
                        {riskyDisabledReason}
                      </div>
                    )}
                  </div>
                </div>
                {(() => {
                  const latestAction = getLatestSurfaceControlAction(data.controlActions, surface.id);
                  return latestAction?.event_id && expandedSurfaceCardActionId === latestAction.event_id ? (
                    <>
                      <ActionDetailList actionId={latestAction.event_id} details={data.controlActionDetails} />
                      <ActionGuidance latestAction={latestAction} availableActions={surfaceActions} />
                    </>
                  ) : null;
                })()}
              </div>
              );
            })}
          </div>
        </Panel>

        <Panel title={mt("chronos_control_model", "Control Model")}>
          <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-4 text-[11px] leading-6 text-white/55">
            {mt("chronos_control_model_description", "Chronos is a control surface. It does not mutate mission or runtime state directly. Each button issues a deterministic backend action through mission_controller, agent-runtime-supervisor, or surface_runtime, then refreshes the control-plane view.")}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel title={mt("chronos_live_agent_conversation", "Agent Traffic")}>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setMessageMissionFilter("all");
                setSelectedMissionId(null);
              }}
              className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                messageMissionFilter === "all"
                  ? "border-cyan-300/20 bg-cyan-400/10 text-cyan-100/85"
                  : "border-white/10 bg-white/5 text-white/45 hover:bg-white/10"
              }`}
            >
              {mt("chronos_all_missions", "all missions")}
            </button>
            {data.activeMissions.map((mission) => (
              <button
                key={mission.missionId}
                type="button"
                onClick={() => {
                  setMessageMissionFilter(mission.missionId);
                  setSelectedMissionId(mission.missionId);
                }}
                className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                  messageMissionFilter === mission.missionId
                    ? "border-cyan-300/20 bg-cyan-400/10 text-cyan-100/85"
                    : "border-white/10 bg-white/5 text-white/45 hover:bg-white/10"
                }`}
              >
                {mission.missionId}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {filteredAgentMessages.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">{mt("chronos_no_mission_scoped_messages", "No mission-scoped agent messages observed yet.")}</div>
            ) : filteredAgentMessages.map((message, index) => (
              <div key={`${message.agentId}-${message.ts}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(message.tone)}`}>
                    {messageTypeLabel(message.type)}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">{message.agentId}</div>
                  {message.teamRole && (
                    <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                      {message.teamRole}
                    </div>
                  )}
                  {message.missionId && (
                    <div className="text-[10px] text-white/35">{message.missionId}</div>
                  )}
                  <div className="ml-auto text-[9px] font-mono text-white/30">{new Date(message.ts).toLocaleString()}</div>
                </div>
                <div className="mt-2 text-[11px] leading-6 text-white/82">{message.content}</div>
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
                  <span>{mt("chronos_owner", "owner")}: {message.ownerType}/{message.ownerId}</span>
                  {message.channel && <span>{mt("chronos_channel", "channel")}: {message.channel}</span>}
                  {message.thread && <span>{mt("chronos_thread", "thread")}: {message.thread}</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={mt("chronos_selected_mission_thread", "Selected Mission Thread")}>
          <div className="mb-3 text-[10px] uppercase tracking-[0.18em] text-white/45">
            {effectiveMissionId ? `thread view · ${effectiveMissionId}` : mt("chronos_select_mission_to_inspect_thread", "select a mission to inspect a unified thread")}
          </div>
          <div className="space-y-3">
            {!effectiveMissionId || missionThread.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">{mt("chronos_no_unified_mission_thread", "No unified mission thread is available yet.")}</div>
            ) : missionThread.map((entry, index) => (
              <div key={`${entry.type}-${entry.agentId}-${entry.ts}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(entry.tone)}`}>
                    {messageTypeLabel(entry.type)}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">{entry.label}</div>
                  {entry.teamRole && (
                    <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                      {entry.teamRole}
                    </div>
                  )}
                  <div className="ml-auto text-[9px] font-mono text-white/30">{new Date(entry.ts).toLocaleString()}</div>
                </div>
                <div className="mt-2 text-[11px] leading-6 text-white/82">{entry.content}</div>
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
                  {entry.channel && <span>{mt("chronos_channel", "channel")}: {entry.channel}</span>}
                  {entry.thread && <span>{mt("chronos_thread", "thread")}: {entry.thread}</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={mt("chronos_a2a_handoff_trail", "A2A Handoff Trail")}>
          <div className="space-y-3">
            {filteredA2AHandoffs.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">{mt("chronos_no_a2a_handoffs_for_filter", "No A2A handoffs observed for the current mission filter.")}</div>
            ) : filteredA2AHandoffs.map((handoff, index) => (
              <div key={`${handoff.sender}-${handoff.receiver}-${handoff.ts}-${index}`} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="rounded-full border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-cyan-100/80">
                    a2a handoff
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    {handoff.sender} → {handoff.receiver}
                  </div>
                  {handoff.teamRole && (
                    <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                      {handoff.teamRole}
                    </div>
                  )}
                  <div className="ml-auto text-[9px] font-mono text-white/30">{new Date(handoff.ts).toLocaleString()}</div>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-white/35">
                  {mt("chronos_mission", "mission")}: {handoff.missionId}
                  {handoff.intent ? ` · ${mt("chronos_intent", "intent")}: ${handoff.intent}` : ""}
                  {handoff.performative ? ` · ${handoff.performative}` : ""}
                </div>
                {handoff.promptExcerpt && (
                  <div className="mt-2 text-[11px] leading-6 text-white/80">{handoff.promptExcerpt}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
                  {handoff.channel && <span>{mt("chronos_channel", "channel")}: {handoff.channel}</span>}
                  {handoff.thread && <span>{mt("chronos_thread", "thread")}: {handoff.thread}</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

      </section>
    </div>
  );
}

function MetricCard({ icon, label, value, detail }: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-black/25 px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-white/40">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-white/90">{value}</div>
      <div className="mt-1 text-[10px] text-white/35">{detail}</div>
    </div>
  );
}

function MiniSummaryCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-white/42">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-white/88">{value}</div>
      <div className="mt-1 text-[10px] text-white/38">{detail}</div>
    </div>
  );
}

function Panel({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="rounded-2xl border border-white/5 bg-black/25 p-4 scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.3em] text-kyberion-gold/45">{title}</div>
      </div>
      {children}
    </div>
  );
}

function RuntimeCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "gold" | "red" | "cyan";
}) {
  const accentClass = {
    emerald: "text-emerald-300/80",
    gold: "text-kyberion-gold/80",
    red: "text-red-300/80",
    cyan: "text-cyan-300/80",
  }[accent];

  return (
    <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-white/35">{label}</div>
      <div className={`mt-2 text-lg font-semibold ${accentClass}`}>{value}</div>
    </div>
  );
}
