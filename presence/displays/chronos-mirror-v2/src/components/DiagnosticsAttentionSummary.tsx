'use client';

import { AlertTriangle, CheckCircle2, CircleHelp, Send, Server } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveChronosLocale, uxText } from '../lib/ux-vocabulary';
import {
  parseDiagnosticsResponse,
  type ClientDiagnosticsPayload,
} from '../lib/intelligence-diagnostics-response';

type DiagnosticsAttentionSummaryProps = {
  tenant?: string;
  onOpenView?: (viewId: string, missionId?: string) => void;
};

type DiagnosticsPayload = ClientDiagnosticsPayload;

type AttentionItem = {
  id: string;
  title: string;
  detail: string;
  kind: 'mission' | 'runtime' | 'surface' | 'delivery';
  tone: 'critical' | 'warning' | 'info';
  missionId?: string;
};

export function DiagnosticsAttentionSummary({
  tenant,
  onOpenView,
}: DiagnosticsAttentionSummaryProps) {
  const locale = resolveChronosLocale();
  const [data, setData] = useState<DiagnosticsPayload>({
    activeMissions: [],
    runtimeDoctor: [],
    surfaces: [],
    recentSurfaceOutbox: [],
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    void fetch(`/api/intelligence${query}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = parseDiagnosticsResponse(await response.json().catch(() => null));
        if (!response.ok || !payload) throw new Error('Invalid diagnostics response');
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  const attentionItems = useMemo<AttentionItem[]>(() => {
    const missions = data.activeMissions
      .filter((mission) => mission.status === 'paused' || mission.status === 'failed')
      .slice(0, 3)
      .map((mission) => ({
        id: `mission-${mission.missionId}`,
        title: mission.missionId || uxText('chronos_unknown_mission', locale),
        detail: `${mission.status || uxText('chronos_unknown_status', locale)} · ${uxText('chronos_next_tasks', locale)} ${mission.nextTaskCount || 0}`,
        kind: 'mission' as const,
        tone: 'critical' as const,
        missionId: mission.missionId,
      }));
    const runtimes = data.runtimeDoctor.slice(0, 3).map((finding) => ({
      id: `runtime-${finding.agentId}`,
      title: finding.agentId || uxText('chronos_unknown_runtime', locale),
      detail: finding.reason || uxText('chronos_runtime_needs_review', locale),
      kind: 'runtime' as const,
      tone: finding.severity === 'critical' ? ('critical' as const) : ('warning' as const),
    }));
    const surfaces = data.surfaces
      .filter((surface) => surface.health && surface.health !== 'healthy')
      .slice(0, 3)
      .map((surface) => ({
        id: `surface-${surface.id}`,
        title: surface.id || uxText('chronos_unknown_surface', locale),
        detail: `${surface.health || uxText('chronos_unknown_status', locale)} · ${surface.controlSummary || uxText('chronos_surface_needs_review', locale)}`,
        kind: 'surface' as const,
        tone: 'warning' as const,
      }));
    const delivery = data.recentSurfaceOutbox.slice(0, 2).map((message) => ({
      id: `delivery-${message.message_id}`,
      title: message.surface || uxText('chronos_delivery', locale),
      detail: message.text || uxText('chronos_delivery_needs_review', locale),
      kind: 'delivery' as const,
      tone: 'info' as const,
    }));
    return [...missions, ...runtimes, ...surfaces, ...delivery];
  }, [data, locale]);

  const counts = {
    missions: data.activeMissions.filter(
      (mission) => mission.status === 'paused' || mission.status === 'failed'
    ).length,
    runtimes: data.runtimeDoctor.length,
    surfaces: data.surfaces.filter((surface) => surface.health !== 'healthy').length,
    delivery: data.recentSurfaceOutbox.length,
  };

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_diagnostics_attention_eyebrow', locale)}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight kb-text-primary">
            {uxText('chronos_diagnostics_attention_title', locale)}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 kb-text-secondary">
            {uxText('chronos_diagnostics_attention_description', locale)}
          </p>
        </div>
        <div className="rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1 text-[10px] kb-text-secondary">
          {attentionItems.length} {uxText('chronos_items_to_check', locale)}
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={<AlertTriangle size={14} />}
          label={uxText('chronos_diagnostics_missions_attention', locale)}
          value={counts.missions}
        />
        <SummaryCard
          icon={<Server size={14} />}
          label={uxText('chronos_diagnostics_runtime_attention', locale)}
          value={counts.runtimes}
        />
        <SummaryCard
          icon={<CircleHelp size={14} />}
          label={uxText('chronos_diagnostics_surface_attention', locale)}
          value={counts.surfaces}
        />
        <SummaryCard
          icon={<Send size={14} />}
          label={uxText('chronos_diagnostics_delivery_attention', locale)}
          value={counts.delivery}
        />
      </div>

      <div className="mt-5 grid gap-3">
        {attentionItems.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border kb-status-positive-border kb-status-positive-surface px-4 py-4 text-sm kb-status-positive">
            <CheckCircle2 size={16} />
            {uxText('chronos_diagnostics_no_attention', locale)}
          </div>
        ) : (
          attentionItems.map((item) => (
            <div
              key={item.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${item.tone === 'critical' ? 'kb-status-negative-border kb-status-negative-surface' : item.tone === 'warning' ? 'kb-status-warning-border kb-status-warning-surface' : 'kb-border-subtle kb-surface-sunken'}`}
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold kb-text-primary">{item.title}</div>
                <div className="mt-1 text-[11px] leading-5 kb-text-secondary">{item.detail}</div>
              </div>
              {onOpenView ? (
                <button
                  type="button"
                  onClick={() =>
                    onOpenView(
                      item.kind === 'mission'
                        ? 'mission-control-plane'
                        : item.kind === 'runtime'
                          ? 'runtime-lease-doctor'
                          : item.kind === 'surface'
                            ? 'needs-attention'
                            : 'recent-surface-outbox',
                      item.missionId
                    )
                  }
                  className="shrink-0 rounded-lg border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] font-semibold kb-text-accent"
                >
                  {uxText('chronos_open_related_view', locale)}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] kb-text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold kb-text-primary">{value}</div>
    </div>
  );
}
