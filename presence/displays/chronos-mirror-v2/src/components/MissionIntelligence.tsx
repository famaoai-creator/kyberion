"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Activity, Bot, GitBranch, Radar } from "lucide-react";

interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  planReady: boolean;
  nextTaskCount: number;
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

interface IntelligencePayload {
  activeMissions: MissionSummary[];
  recentEvents: OrchestrationEvent[];
  ownerSummaries: OwnerSummary[];
  surfaceOutbox: {
    slack: number;
    chronos: number;
  };
  recentSurfaceOutbox: SurfaceOutboxMessage[];
  runtime: RuntimeSummary;
  runtimeLeases: RuntimeLease[];
  runtimeDoctor: RuntimeDoctorFinding[];
}

export function MissionIntelligence() {
  const [data, setData] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remediationTarget, setRemediationTarget] = useState<string | null>(null);

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
      const refreshed = await fetch("/api/intelligence", { cache: "no-store" });
      const refreshedBody = await refreshed.json();
      if (!refreshed.ok) {
        throw new Error(refreshedBody.error || "Failed to refresh mission intelligence");
      }
      setData(refreshedBody);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to remediate runtime lease");
    } finally {
      setRemediationTarget(null);
    }
  };

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

  if (!data) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-[11px] uppercase tracking-[0.25em] text-kyberion-gold/40">Loading mission intelligence...</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col gap-6 overflow-y-auto pr-1">
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          icon={<GitBranch size={14} />}
          label="Active Missions"
          value={String(data.activeMissions.length)}
          detail="Durable contracts in execution"
        />
        <MetricCard
          icon={<Bot size={14} />}
          label="Agent Runtime"
          value={`${data.runtime.ready}/${data.runtime.total}`}
          detail={`busy=${data.runtime.busy} error=${data.runtime.error}`}
        />
        <MetricCard
          icon={<Radar size={14} />}
          label="Recent Events"
          value={String(data.recentEvents.length)}
          detail="Latest orchestration transitions"
        />
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.2fr,1fr,1fr]">
        <Panel title="Mission Control Plane">
          <div className="space-y-3">
            {data.activeMissions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No active missions.</div>
            ) : data.activeMissions.map((mission) => (
              <div key={mission.missionId} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
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
                <div className="mt-3 text-[10px] text-white/55">
                  next tasks: <span className="font-mono text-white/80">{mission.nextTaskCount}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Recent Orchestration Events">
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

        <Panel title="Runtime Lease Doctor">
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
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/35">Active Runtime Leases</div>
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
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr,1fr]">
        <Panel title="Owner Summaries">
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

        <Panel title="Runtime Summary">
          <div className="grid grid-cols-2 gap-3">
            <RuntimeCell label="ready" value={data.runtime.ready} />
            <RuntimeCell label="busy" value={data.runtime.busy} />
            <RuntimeCell label="error" value={data.runtime.error} />
            <RuntimeCell label="leases" value={data.runtimeLeases.length} />
            <RuntimeCell label="slack outbox" value={data.surfaceOutbox.slack} />
            <RuntimeCell label="chronos outbox" value={data.surfaceOutbox.chronos} />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel title="Recent Surface Outbox">
          <div className="space-y-3">
            {data.recentSurfaceOutbox.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No pending or recent surface outbox messages.</div>
            ) : data.recentSurfaceOutbox.map((message) => (
              <div key={message.message_id} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                    {message.surface} · {message.source} · {message.channel}
                  </div>
                  <div className="text-[9px] font-mono text-white/30">{new Date(message.created_at).toLocaleString()}</div>
                </div>
                <div className="mt-2 text-[11px] text-white/80">{message.text}</div>
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

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-black/25 p-4">
      <div className="mb-4 text-[10px] uppercase tracking-[0.3em] text-kyberion-gold/45">{title}</div>
      {children}
    </div>
  );
}

function RuntimeCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-white/35">{label}</div>
      <div className="mt-2 text-lg font-semibold text-white/85">{value}</div>
    </div>
  );
}
