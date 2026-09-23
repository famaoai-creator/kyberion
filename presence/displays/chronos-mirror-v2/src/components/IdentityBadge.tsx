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

  // UI-07: the shared `ui:badge` look (neutral tone) in the page header.
  return (
    <span className="kb-badge" title={data.vision || undefined}>
      {name} · <span className="chronos-mission-cell__id">{agentId}</span> · {tier}
    </span>
  );
}
