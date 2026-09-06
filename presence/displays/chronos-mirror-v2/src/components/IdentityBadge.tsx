'use client';

import { useEffect, useState } from 'react';
import { parseIdentityResponse } from '../lib/identity-response';

export function IdentityBadge() {
  const [data, setData] = useState<ReturnType<typeof parseIdentityResponse>>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/identity')
      .then((r) => r.json().catch(() => null))
      .then((payload) => {
        const parsed = parseIdentityResponse(payload);
        if (!cancelled) {
          if (!parsed) setError('invalid identity response');
          else setData(parsed);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error || !data) return null;
  // Personal identity setup is optional for the tenant/project console.
  // Do not present it as a blocker when the operator can already work.
  if (!data.onboarded) return null;

  const name = data.sovereign?.name || 'Sovereign';
  const agentId = data.agent?.agent_id || 'agent';
  const tier = data.agent?.trust_tier || '—';

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-[color:var(--kb-accent)]/30 bg-[color:var(--kb-panel-bg)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[color:var(--kb-text-primary)]"
      title={data.vision || undefined}
    >
      <span className="text-[color:var(--kb-text-primary)]">{name}</span>
      <span className="text-[color:var(--kb-text-secondary)]">·</span>
      <span className="text-[color:var(--kb-accent)]">{agentId}</span>
      <span className="text-[color:var(--kb-text-secondary)]">·</span>
      <span className="text-[color:var(--kb-text-secondary)]">{tier}</span>
    </div>
  );
}
