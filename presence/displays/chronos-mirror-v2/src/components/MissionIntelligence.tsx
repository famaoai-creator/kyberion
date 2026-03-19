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

interface IntelligencePayload {
  activeMissions: MissionSummary[];
  recentEvents: OrchestrationEvent[];
  runtime: RuntimeSummary;
}

export function MissionIntelligence() {
  const [data, setData] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <section className="grid gap-4 lg:grid-cols-[1.3fr,1fr]">
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
