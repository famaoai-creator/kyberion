'use client';

import { opsApiPath } from '../../lib/ops/ops-api-path';
import { useEffect, useState } from 'react';
import { parseIdentityResponse } from '../../lib/ops/identity-response';
import { useChronosLocale } from '../../lib/ops/hooks';
import { uxText } from '../../lib/ops/ux-vocabulary';

export function IdentityBadge() {
  const locale = useChronosLocale();
  const [data, setData] = useState<ReturnType<typeof parseIdentityResponse>>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(opsApiPath('/identity'))
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

  // The agent id and trust tier are internal: behind a disclosure, not a header chip.
  return (
    <details className="chronos-viewer-details">
      <summary>{uxText('ux_b_ops_viewer_details', locale)}</summary>
      <span className="kb-badge" title={data.vision || undefined}>
        {name} · <span className="chronos-mission-cell__id">{agentId}</span> · {tier}
      </span>
    </details>
  );
}
