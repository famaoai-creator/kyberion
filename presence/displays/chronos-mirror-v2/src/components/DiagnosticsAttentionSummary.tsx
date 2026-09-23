'use client';

import { useEffect, useMemo, useState } from 'react';
import type { KbTone } from '@agent/core/a2ui-catalog';
import { Button, Callout, Metric, Section, Table } from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText } from '../lib/ux-vocabulary';
import { humanizeMissionId } from './ChronosOffice';
import { ChronosMeta } from './chronos-ui';
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
  const locale = useChronosLocale();
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

  const openTarget = (item: AttentionItem) =>
    onOpenView?.(
      item.kind === 'mission'
        ? 'mission-control-plane'
        : item.kind === 'runtime'
          ? 'runtime-lease-doctor'
          : item.kind === 'surface'
            ? 'needs-attention'
            : 'recent-surface-outbox',
      item.missionId
    );

  return (
    <Section
      title={uxText('chronos_diagnostics_attention_title', locale)}
      description={uxText('chronos_diagnostics_attention_description', locale)}
    >
      {error ? <Callout tone="danger" title={error} /> : null}

      <div className="chronos-metrics">
        <Metric
          label={uxText('chronos_diagnostics_missions_attention', locale)}
          value={counts.missions}
          tone={counts.missions > 0 ? 'danger' : undefined}
        />
        <Metric
          label={uxText('chronos_diagnostics_runtime_attention', locale)}
          value={counts.runtimes}
          tone={counts.runtimes > 0 ? 'warning' : undefined}
        />
        <Metric
          label={uxText('chronos_diagnostics_surface_attention', locale)}
          value={counts.surfaces}
          tone={counts.surfaces > 0 ? 'warning' : undefined}
        />
        <Metric
          label={uxText('chronos_diagnostics_delivery_attention', locale)}
          value={counts.delivery}
          tone={counts.delivery > 0 ? 'info' : undefined}
        />
      </div>

      {attentionItems.length === 0 ? (
        <Callout tone="success" title={uxText('chronos_diagnostics_no_attention', locale)} />
      ) : (
        <Table
          caption={uxMessage(
            'chronos_diagnostics_items_count',
            { count: attentionItems.length },
            '{count} items to check',
            locale
          )}
          columns={[
            {
              key: 'severity',
              label: uxText('chronos_diagnostics_col_severity', locale),
              width: '7rem',
            },
            { key: 'item', label: uxText('chronos_diagnostics_col_item', locale) },
            { key: 'kind', label: uxText('chronos_diagnostics_col_kind', locale), width: '11rem' },
            { key: 'open', label: uxText('chronos_diagnostics_col_actions', locale), align: 'end' },
          ]}
          row_key="id"
          rows={attentionItems.map((item) => ({
            id: item.id,
            severity: {
              badge: uxText(SEVERITY_LABEL_KEY[item.tone], locale),
              tone: SEVERITY_TONE[item.tone],
            },
            item: (
              <span className="chronos-work-cell">
                <span className="chronos-work-cell__title">
                  {item.kind === 'mission' && item.missionId
                    ? humanizeMissionId(item.missionId)
                    : item.title}
                </span>
                {item.kind === 'mission' && item.missionId ? (
                  <ChronosMeta mono>{item.missionId}</ChronosMeta>
                ) : null}
                <ChronosMeta>{item.detail}</ChronosMeta>
              </span>
            ),
            kind: uxText(KIND_LABEL_KEY[item.kind], locale),
            open: onOpenView ? (
              <Button
                variant="ghost"
                label={uxText('chronos_open_related_view', locale)}
                onClick={() => openTarget(item)}
              />
            ) : (
              ''
            ),
          }))}
        />
      )}
    </Section>
  );
}

const SEVERITY_TONE: Record<AttentionItem['tone'], KbTone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_LABEL_KEY: Record<AttentionItem['tone'], string> = {
  critical: 'chronos_diagnostics_severity_critical',
  warning: 'chronos_diagnostics_severity_warning',
  info: 'chronos_diagnostics_severity_info',
};

const KIND_LABEL_KEY: Record<AttentionItem['kind'], string> = {
  mission: 'chronos_diagnostics_missions_attention',
  runtime: 'chronos_diagnostics_runtime_attention',
  surface: 'chronos_diagnostics_surface_attention',
  delivery: 'chronos_diagnostics_delivery_attention',
};
