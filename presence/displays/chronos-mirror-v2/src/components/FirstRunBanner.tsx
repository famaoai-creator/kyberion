"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

const STORAGE_KEY = "chronos.first-run.dismissed";

interface IdentitySummary {
  onboarded: boolean;
  agent: { agent_id: string | null } | null;
  sovereign: { name: string | null } | null;
}

interface AgentsSummary {
  total: number;
}

export function FirstRunBanner() {
  const [identity, setIdentity] = useState<IdentitySummary | null>(null);
  const [agents, setAgents] = useState<AgentsSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1") {
      setDismissed(true);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch("/api/identity").then((r) => r.json()).catch(() => null),
      fetch("/api/agents").then((r) => r.json()).catch(() => null),
    ]).then(([id, ag]) => {
      if (!cancelled) {
        setIdentity(id);
        setAgents(ag);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || !identity || !agents) return null;

  const isFreshOnboard = identity.onboarded && agents.total === 0;
  if (!isFreshOnboard) return null;

  const dismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // storage may be denied — ignore
      }
    }
  };

  const name = identity.sovereign?.name || "Sovereign";
  const agentId = identity.agent?.agent_id || "your agent";

  return (
    <div className="mx-1 mt-2 flex items-start gap-3 rounded-2xl border border-cyan-400/25 bg-gradient-to-r from-cyan-500/10 via-cyan-400/5 to-transparent p-4">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-cyan-300">
        <Sparkles size={14} />
      </div>
      <div className="flex-1 text-[12px] leading-relaxed text-white/80">
        <div className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">First Run</div>
        <div className="mt-1 text-white/85">
          Welcome, <span className="font-semibold text-white">{name}</span>. Identity is sealed as{" "}
          <span className="font-mono text-cyan-300">{agentId}</span>, but no agent runtime is live yet.
        </div>
        <ol className="mt-2 list-decimal pl-4 text-white/65 text-[11.5px] space-y-0.5">
          <li>Run <span className="font-bold text-white/85">Prereq Check</span> and <span className="font-bold text-white/85">Setup Report</span> from the left rail.</li>
          <li>Open <span className="font-bold text-white/85">Agent Runtimes</span> (top-right) and Spawn First Agent.</li>
          <li>Run a Verify check (Vital Check / Diagnostics) to confirm the ecosystem is healthy.</li>
          <li>Promote the simulated Tutorial into a real Mission once you're ready.</li>
        </ol>
      </div>
      <button
        onClick={dismiss}
        className="opacity-50 transition hover:opacity-90"
        aria-label="Dismiss first run banner"
      >
        <X size={14} />
      </button>
    </div>
  );
}
