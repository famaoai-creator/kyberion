"use client";

import { useEffect, useState } from "react";
import { Crown } from "lucide-react";

interface IdentityResponse {
  status: string;
  onboarded: boolean;
  sovereign: {
    name: string | null;
    interaction_style: string | null;
    primary_domain: string | null;
  } | null;
  agent: {
    agent_id: string | null;
    trust_tier: string | null;
  } | null;
  vision: string | null;
}

export function IdentityBadge() {
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/identity")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error || !data) return null;
  if (!data.onboarded) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-300/90">
        <Crown size={12} />
        <span>Onboarding required</span>
      </div>
    );
  }

  const name = data.sovereign?.name || "Sovereign";
  const agentId = data.agent?.agent_id || "agent";
  const tier = data.agent?.trust_tier || "—";

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/75"
      title={data.vision || undefined}
    >
      <Crown size={12} className="text-cyan-300" />
      <span className="text-white/85">{name}</span>
      <span className="text-white/30">·</span>
      <span className="text-cyan-300/85">{agentId}</span>
      <span className="text-white/30">·</span>
      <span className="text-white/55">{tier}</span>
    </div>
  );
}
