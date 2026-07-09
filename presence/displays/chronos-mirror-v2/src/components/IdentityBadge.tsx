'use client';

import { useEffect, useState } from 'react';
import { Crown } from 'lucide-react';

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
    fetch('/api/identity')
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
      <div className="flex items-center gap-2 rounded-lg border border-[color:var(--kb-warning)]/30 bg-amber-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[color:var(--kb-warning)]">
        <Crown size={12} />
        <span>Onboarding required</span>
      </div>
    );
  }

  const name = data.sovereign?.name || 'Sovereign';
  const agentId = data.agent?.agent_id || 'agent';
  const tier = data.agent?.trust_tier || '—';

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-[color:var(--kb-accent)]/30 bg-[color:var(--kb-panel-bg)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[color:var(--kb-text-primary)]"
      title={data.vision || undefined}
    >
      <Crown size={12} className="text-[color:var(--kb-accent)]" />
      <span className="text-[color:var(--kb-text-primary)]">{name}</span>
      <span className="text-[color:var(--kb-text-secondary)]">·</span>
      <span className="text-[color:var(--kb-accent)]">{agentId}</span>
      <span className="text-[color:var(--kb-text-secondary)]">·</span>
      <span className="text-[color:var(--kb-text-secondary)]">{tier}</span>
    </div>
  );
}
