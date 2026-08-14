'use client';

import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText } from '../lib/ux-vocabulary';

const STORAGE_KEY = 'chronos.first-run.dismissed';

interface IdentitySummary {
  onboarded: boolean;
  agent: { agent_id: string | null } | null;
  sovereign: { name: string | null } | null;
}

interface AgentsSummary {
  total: number;
}

export function FirstRunBanner() {
  const locale = useChronosLocale();
  const [identity, setIdentity] = useState<IdentitySummary | null>(null);
  const [agents, setAgents] = useState<AgentsSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === '1') {
      setDismissed(true);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch('/api/identity')
        .then((r) => r.json())
        .catch(() => null),
      fetch('/api/agents')
        .then((r) => r.json())
        .catch(() => null),
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
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, '1');
      } catch {
        // storage may be denied — ignore
      }
    }
  };

  const name = identity.sovereign?.name || 'Sovereign';
  const agentId = identity.agent?.agent_id || 'your agent';
  return (
    <div className="mx-1 mt-2 flex items-start gap-3 rounded-2xl border kb-border-accent bg-gradient-to-r from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent p-4">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full kb-surface-accent kb-text-accent">
        <Sparkles size={14} />
      </div>
      <div className="flex-1 text-[12px] leading-relaxed kb-text-primary">
        <div className="text-[10px] uppercase tracking-[0.3em] kb-text-accent">
          {uxText('chronos_first_run_eyebrow', locale)}
        </div>
        <div className="mt-1 kb-text-primary">
          {uxMessage(
            'chronos_first_run_welcome',
            { name, agent: agentId },
            'Welcome, {name}. Identity is registered as {agent}, but no agent is running yet.',
            locale
          )}
        </div>
        <ol className="mt-2 list-decimal pl-4 kb-text-secondary text-[11.5px] space-y-0.5">
          {locale === 'ja' ? (
            <>
              <li>{uxText('chronos_first_run_step_prereq', locale)}</li>
              <li>{uxText('chronos_first_run_step_agent', locale)}</li>
              <li>{uxText('chronos_first_run_step_diagnostics', locale)}</li>
              <li>{uxText('chronos_first_run_step_tutorial', locale)}</li>
            </>
          ) : (
            <>
              <li>
                Run <span className="font-bold kb-text-primary">Prereq Check</span> and{' '}
                <span className="font-bold kb-text-primary">Setup Report</span> from the left rail.
              </li>
              <li>
                Open <span className="font-bold kb-text-primary">Agent Runtimes</span> (top-right)
                and Spawn First Agent.
              </li>
              <li>
                Run a Verify check (Vital Check / Diagnostics) to confirm the ecosystem is healthy.
              </li>
              <li>Promote the simulated Tutorial into a real Mission once you're ready.</li>
            </>
          )}
        </ol>
      </div>
      <button
        onClick={dismiss}
        className="opacity-50 transition hover:opacity-90"
        aria-label={uxText('chronos_first_run_dismiss', locale)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
