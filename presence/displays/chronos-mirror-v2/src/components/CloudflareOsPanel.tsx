'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

type HeldAction = {
  id: string;
  op: string;
  missionId: string;
  status: string;
  submittedAt: string;
  submittedBy: string;
  tenantSlug?: string;
  irreversible?: boolean;
  effectBinding?: string;
  failureRecorded?: boolean;
};

type Observation = {
  id: string;
  service: string;
  resourceRef: string;
  tier: string;
  purpose: string;
  summary: string;
  observedAt: string;
};

type CloudflareOsSnapshot = {
  heldActions: HeldAction[];
  observations: Observation[];
};

export function CloudflareOsPanel({ missionId }: { missionId?: string | null }) {
  const locale = useChronosLocale();
  const [snapshot, setSnapshot] = useState<CloudflareOsSnapshot>({
    heldActions: [],
    observations: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const loadSnapshot = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const query = missionId ? `?mission_id=${encodeURIComponent(missionId)}` : '';
      const response = await fetch(`/api/os/control-plane${query}`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        heldActions?: HeldAction[];
        observations?: Observation[];
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `OS control plane ${response.status}`);
      }
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setSnapshot({
        heldActions: Array.isArray(payload.heldActions) ? payload.heldActions : [],
        observations: Array.isArray(payload.observations) ? payload.observations : [],
      });
      setError(null);
    } catch (reason) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setSnapshot({ heldActions: [], observations: [] });
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [missionId]);

  useEffect(() => {
    void loadSnapshot();
    return () => {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [loadSnapshot]);

  return (
    <section className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_os_control_plane', locale)}
          </div>
          <h2 className="mt-1 text-lg font-semibold kb-text-primary">
            {uxText('chronos_os_held_actions_observations', locale)}
          </h2>
          <p className="mt-2 text-[11px] leading-5 kb-text-secondary">
            {uxText('chronos_os_control_plane_description', locale)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadSnapshot()}
          disabled={loading}
          className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-border-accent disabled:opacity-50"
        >
          {loading ? uxText('chronos_ac_refreshing', locale) : uxText('chronos_ac_refresh', locale)}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] kb-text-muted">
            {uxText('chronos_os_held_actions', locale)} ({snapshot.heldActions.length})
          </div>
          <div className="space-y-2">
            {snapshot.heldActions.length ? (
              snapshot.heldActions.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="truncate text-[11px] kb-text-primary">{item.op}</strong>
                    <span className="rounded-full border kb-border-subtle px-2 py-1 text-[9px] uppercase tracking-[0.14em] kb-text-accent">
                      {item.status}
                    </span>
                  </div>
                  <div className="mt-2 text-[10px] leading-5 kb-text-secondary">
                    {item.missionId} · {item.tenantSlug || 'public'} · {item.submittedBy}
                  </div>
                  <div className="mt-1 text-[10px] leading-5 kb-text-muted">
                    {item.irreversible
                      ? uxText('chronos_os_irreversible', locale)
                      : uxText('chronos_os_reversible', locale)}{' '}
                    ·{' '}
                    {item.effectBinding || uxText('chronos_os_effect_binding_unavailable', locale)}
                    {item.failureRecorded ? ` · ${uxText('chronos_os_apply_failed', locale)}` : ''}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[11px] kb-text-muted">
                {uxText('chronos_os_no_held_actions', locale)}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] kb-text-muted">
            {uxText('chronos_os_observations', locale)} ({snapshot.observations.length})
          </div>
          <div className="space-y-2">
            {snapshot.observations.length ? (
              snapshot.observations.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="truncate text-[11px] kb-text-primary">{item.service}</strong>
                    <span className="text-[9px] uppercase tracking-[0.14em] kb-text-muted">
                      {item.tier}
                    </span>
                  </div>
                  <div className="mt-2 text-[10px] leading-5 kb-text-secondary">
                    {item.resourceRef} · {item.purpose}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[10px] leading-5 kb-text-muted">
                    {item.summary}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[11px] kb-text-muted">
                {uxText('chronos_os_no_observations', locale)}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
