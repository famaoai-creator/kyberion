'use client';

import { useEffect, useMemo, useState } from 'react';
import type { KbStatus, KbTone } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Code,
  EmptyState,
  Grid,
  KbChart,
  KeyValue,
  List,
  Metric,
  Section,
  Segmented,
  Select,
  Skeleton,
  StatusPill,
  Table,
  isKbStatus,
} from '@agent/shared-ui';

import {
  findLatestMissionHandoff,
  type MissionAssetCategory,
} from '../lib/mission-progress-client';
import { buildAttentionItems, type AttentionItem } from '../lib/operator-console';
import { buildRuntimeTopologyGraph } from '../lib/runtime-topology';
import { buildUserFacingError } from '../lib/user-facing-error';
import { useChronosLocale } from '../lib/hooks';
import { chronosSpeechLocale, uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import { LiveSyncScheduler, bindVisibilityToLiveSync } from '../lib/live-sync';
import { parseFocusedOperatorResponse } from '../lib/focused-operator-response';
import { humanizeMissionId } from './ChronosOffice';
import {
  ChronosDiagram,
  ChronosFieldScope,
  ChronosInline,
  ChronosMeta,
  ChronosToolbar,
} from './chronos-ui';
import { WsSelectTable, WsTitleCell } from './ChronosWsParts';
import { TraceViewer } from './TraceViewer';
import {
  attentionItemTargetMissionId,
  attentionItemTargetViewId,
  formatBytes,
  formatTimestamp,
  isEditableHotkeyTarget,
  loadFocusedOperatorSelectedSessionId,
  pickDefaultSessionId,
  resolveComputerSessionHotkeySelection,
  saveFocusedOperatorSelectedSessionId,
  type FocusedViewId,
  type Payload,
} from './FocusedOperatorViewModel';

export {
  attentionItemTargetMissionId,
  attentionItemTargetViewId,
  pickDefaultSessionId,
  resolveComputerSessionHotkeySelection,
} from './FocusedOperatorViewModel';

type AssetFilter = 'all' | MissionAssetCategory;
type FlowKind = Payload['runtimeTopology']['flows'][number]['kind'];

/** Localized focused-view title (static keys so the vocabulary contract can verify them). */
function viewTitle(viewId: FocusedViewId, locale: SupportedLocale): string {
  switch (viewId) {
    case 'needs-attention':
      return uxText('chronos_fov_title_needs_attention', locale);
    case 'mission-control-plane':
      return uxText('chronos_fov_title_mission_control', locale);
    case 'computer-sessions':
      return uxText('chronos_fov_title_computer_sessions', locale);
    case 'runtime-topology-map':
      return uxText('chronos_fov_title_runtime_topology', locale);
    case 'runtime-lease-doctor':
      return uxText('chronos_fov_title_runtime_governance', locale);
    case 'recent-surface-outbox':
      return uxText('chronos_fov_title_delivery_exceptions', locale);
    case 'secret-approval-queue':
      return uxText('chronos_fov_title_secret_approvals', locale);
    case 'owner-summaries':
      return uxText('chronos_fov_title_audit_trail', locale);
    case 'trace-viewer':
      return uxText('chronos_fov_title_trace_viewer', locale);
  }
}

function assetFilterOptions(locale: SupportedLocale): Array<{ value: AssetFilter; label: string }> {
  return [
    { value: 'all', label: uxText('chronos_fov_asset_all', locale) },
    { value: 'deliverables', label: uxText('chronos_fov_asset_deliverables', locale) },
    { value: 'artifacts', label: uxText('chronos_fov_asset_artifacts', locale) },
    { value: 'outputs', label: uxText('chronos_fov_asset_outputs', locale) },
    { value: 'evidence', label: uxText('chronos_fov_asset_evidence', locale) },
  ];
}

function assetCategoryLabel(category: MissionAssetCategory, locale: SupportedLocale): string {
  return assetFilterOptions(locale).find((option) => option.value === category)?.label || category;
}

function flowKindLabel(kind: FlowKind, locale: SupportedLocale): string {
  if (kind === 'a2a') return uxText('chronos_fov_flow_kind_a2a', locale);
  if (kind === 'agent_message') return uxText('chronos_fov_flow_kind_agent_message', locale);
  return uxText('chronos_fov_flow_kind_surface_link', locale);
}

function riskLabel(
  level: Payload['secretApprovals'][number]['riskLevel'],
  locale: SupportedLocale
): string {
  if (level === 'critical') return uxText('chronos_fov_risk_critical', locale);
  if (level === 'high') return uxText('chronos_fov_risk_high', locale);
  if (level === 'medium') return uxText('chronos_fov_risk_medium', locale);
  return uxText('chronos_fov_risk_low', locale);
}

const RISK_TONE: Record<Payload['secretApprovals'][number]['riskLevel'], KbTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const CONTROL_TONE_STATUS: Record<Payload['activeMissions'][number]['controlTone'], KbStatus> = {
  planning: 'planned',
  ready: 'ready',
  attention: 'review',
  pending: 'pending',
};

const ATTENTION_CALLOUT_TONE: Record<AttentionItem['tone'], 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

const RAW_STATUS_ALIASES: Record<string, KbStatus> = {
  ok: 'done',
  success: 'done',
  succeeded: 'done',
  idle: 'ready',
  in_progress: 'running',
  closed: 'stopped',
  exited: 'stopped',
  terminated: 'stopped',
  warning: 'degraded',
  critical: 'failed',
  unknown: 'n/a',
};

/** Map a raw runtime / session state onto the canonical status set (undefined = no pill). */
function asKbStatus(raw: string | null | undefined): KbStatus | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (isKbStatus(key)) return key;
  return RAW_STATUS_ALIASES[key];
}

/** Short time for diagram gutters (`at`). */
function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(chronosSpeechLocale(), { hour: '2-digit', minute: '2-digit' });
}

function endpointLabel(id: string): string {
  return id.includes(':') ? id.split(':').slice(-1)[0] : id;
}

function missionAssetUrl(missionId: string, path: string): string {
  return `/api/mission-asset?missionId=${encodeURIComponent(missionId)}&path=${encodeURIComponent(path)}`;
}

function openConciergeSecretIntroduce(): void {
  // Chronos and Concierge are different surfaces; prefer absolute when known.
  const conciergePort =
    typeof window !== 'undefined' ? window.localStorage.getItem('kyberion.conciergePort') : null;
  if (conciergePort) {
    window.open(
      `http://127.0.0.1:${conciergePort}/settings#secret-introduce`,
      '_blank',
      'noopener,noreferrer'
    );
    return;
  }
  window.location.assign('/settings#secret-introduce');
}

export function FocusedOperatorView({
  viewId,
  onBack,
  onOpenView,
  focusedMissionId,
  onOpenMissionThread,
  tenant,
  organizationId,
  projectId,
}: {
  viewId: FocusedViewId;
  onBack: () => void;
  onOpenView?: (viewId: FocusedViewId, missionId?: string | null) => void;
  focusedMissionId?: string | null;
  onOpenMissionThread?: (missionId: string) => void;
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}) {
  const locale = useChronosLocale();
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() =>
    loadFocusedOperatorSelectedSessionId()
  );
  const [highlightedMissionId, setHighlightedMissionId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let alive = true;
    const scheduler = new LiveSyncScheduler<Payload>({
      fetchSnapshot: async () => {
        const res = await fetch(
          `/api/intelligence${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
          { cache: 'no-store' }
        );
        const payload = parseFocusedOperatorResponse(await res.json().catch(() => null));
        if (!res.ok || !payload) throw new Error('Invalid operator view response');
        return payload;
      },
      onSnapshot: (snapshot) => {
        if (!alive) return;
        setData(snapshot);
        setError(null);
      },
      onError: (err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
      revisionOf: (snapshot) => snapshot.revision,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    });
    void scheduler.refresh().catch(() => undefined);
    const source =
      typeof window !== 'undefined'
        ? new EventSource(
            `/api/intelligence/stream${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`
          )
        : null;
    source?.addEventListener('message', () => scheduler.invalidate());
    source?.addEventListener('error', () => scheduler.invalidate());
    const unbindVisibility = bindVisibilityToLiveSync(scheduler);
    scheduler.start();
    return () => {
      alive = false;
      source?.close();
      unbindVisibility();
      scheduler.stop();
    };
  }, [tenant, viewId]);

  useEffect(() => {
    if (viewId !== 'computer-sessions') return;
    const sessionId = pickDefaultSessionId(data?.computerSessions || [], selectedSessionId);
    if (!sessionId || sessionId === selectedSessionId) return;
    setSelectedSessionId(sessionId);
  }, [data?.computerSessions, selectedSessionId, viewId]);

  useEffect(() => {
    if (viewId !== 'computer-sessions') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableHotkeyTarget(event.target)) return;
      const nextSessionId = resolveComputerSessionHotkeySelection(
        data?.computerSessions || [],
        selectedSessionId,
        event.key
      );
      if (!nextSessionId) return;
      event.preventDefault();
      setSelectedSessionId(nextSessionId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [data?.computerSessions, selectedSessionId, viewId]);

  useEffect(() => {
    saveFocusedOperatorSelectedSessionId(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (viewId !== 'mission-control-plane') return;
    if (!focusedMissionId) {
      setHighlightedMissionId(null);
      return;
    }
    const timer = window.requestAnimationFrame(() => {
      document.getElementById(`mission-card-${focusedMissionId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      setHighlightedMissionId(focusedMissionId);
    });
    return () => window.cancelAnimationFrame(timer);
  }, [data?.activeMissions.length, focusedMissionId, viewId]);

  const attentionItems = useMemo(() => {
    if (!data) return [];
    return buildAttentionItems({
      missions: data.activeMissions,
      runtimeDoctor: data.runtimeDoctor,
      surfaces: data.surfaces,
      outbox: data.recentSurfaceOutbox.map((entry) => ({
        message_id: entry.message_id,
        surface: entry.surface,
        text: entry.text,
      })),
      secretApprovals: data.secretApprovals.map((request) => ({
        id: request.id,
        title: request.title,
        serviceId: request.serviceId,
        secretKey: request.secretKey,
        riskLevel: request.riskLevel,
      })),
    });
  }, [data]);
  const runtimeGraph = useMemo(() => {
    if (!data) {
      return buildRuntimeTopologyGraph({
        surfaces: [],
        owners: [],
        runtimes: [],
        flows: [],
      });
    }
    return buildRuntimeTopologyGraph(data.runtimeTopology);
  }, [data]);
  const selectedFlow = useMemo(
    () => data?.runtimeTopology.flows.find((flow) => flow.id === selectedFlowId) || null,
    [data, selectedFlowId]
  );

  if (!mounted) {
    return <Skeleton shape="card" lines={4} label={uxText('chronos_fov_loading', locale)} />;
  }

  if (error) {
    const safeError = buildUserFacingError(error, { locale, surface: 'chronos' });
    return (
      <Callout
        tone="danger"
        title={safeError.title}
        body={`${safeError.body} ${safeError.nextAction}`}
      >
        {safeError.traceLine ? <ChronosMeta mono>{safeError.traceLine}</ChronosMeta> : null}
        <ChronosToolbar>
          <Button
            label={uxText('chronos_action_retry', locale)}
            onClick={() => {
              window.location.reload();
            }}
          />
        </ChronosToolbar>
      </Callout>
    );
  }

  if (!data) {
    return <Skeleton shape="card" lines={4} label={uxText('chronos_fov_waiting', locale)} />;
  }

  const assetOptions = assetFilterOptions(locale);

  return (
    <div className="chronos-stack">
      <Section title={viewTitle(viewId, locale)} description={uxText('chronos_fov_hint', locale)}>
        <ChronosToolbar>
          <Button
            label={uxText('chronos_show_full_console', locale)}
            variant="ghost"
            onClick={onBack}
          />
        </ChronosToolbar>
      </Section>

      {viewId === 'needs-attention' &&
        (attentionItems.length === 0 ? (
          <Callout
            tone="success"
            title={uxText('chronos_no_immediate_intervention', locale)}
            body={uxText('chronos_no_blocking_issue', locale)}
          />
        ) : (
          <Section title={viewTitle('needs-attention', locale)}>
            {attentionItems.map((item) => {
              const targetViewId = attentionItemTargetViewId(item);
              return (
                <Callout
                  key={item.id}
                  tone={ATTENTION_CALLOUT_TONE[item.tone]}
                  title={item.title}
                  body={item.reason}
                >
                  {onOpenView && targetViewId ? (
                    <ChronosToolbar>
                      <Button
                        label={uxMessage(
                          'chronos_fov_open_view',
                          { view: viewTitle(targetViewId, locale) },
                          'Open {view}',
                          locale
                        )}
                        onClick={() => onOpenView(targetViewId, attentionItemTargetMissionId(item))}
                      />
                    </ChronosToolbar>
                  ) : null}
                </Callout>
              );
            })}
          </Section>
        ))}

      {viewId === 'mission-control-plane' &&
        (data.activeMissions.length === 0 ? (
          <EmptyState
            title={uxText('chronos_fov_no_missions', locale)}
            body={uxText('chronos_fov_no_missions_detail', locale)}
          />
        ) : (
          data.activeMissions.map((mission) => {
            const progress = data.missionProgress.find(
              (entry) => entry.missionId === mission.missionId
            );
            const assets = (progress?.generatedAssets || []).filter(
              (asset) => assetFilter === 'all' || asset.category === assetFilter
            );
            const dependencies = progress?.dependencies || [];
            const handoffs = data.a2aHandoffs
              .filter((handoff) => handoff.missionId === mission.missionId)
              .sort((a, b) => a.ts.localeCompare(b.ts))
              .slice(-6);
            const latestHandoff = findLatestMissionHandoff(mission.missionId, data.a2aHandoffs);
            const boardStatus = asKbStatus(progress?.boardStatus);
            return (
              <div key={mission.missionId} id={`mission-card-${mission.missionId}`}>
                <Section
                  title={humanizeMissionId(mission.missionId)}
                  description={mission.controlSummary}
                  tone={highlightedMissionId === mission.missionId ? 'accent' : undefined}
                >
                  <ChronosInline>
                    <ChronosMeta mono>{mission.missionId}</ChronosMeta>
                    <StatusPill status={CONTROL_TONE_STATUS[mission.controlTone]} />
                    <Badge label={mission.missionType || 'development'} />
                    <Badge label={mission.tier} />
                  </ChronosInline>

                  <KbChart
                    type="ui:meter"
                    props={{
                      label: uxText('chronos_fov_board_progress', locale),
                      value: progress?.boardStepsDone ?? 0,
                      max: Math.max(1, progress?.boardStepsTotal ?? 0),
                      direction: 'higher_is_better',
                      description: progress
                        ? uxMessage(
                            'chronos_fov_board_progress_detail',
                            {
                              done: progress.boardStepsDone,
                              total: progress.boardStepsTotal,
                            },
                            '{done} of {total} steps done',
                            locale
                          )
                        : uxText('chronos_fov_board_unknown', locale),
                    }}
                  />
                  <Grid min_column_width="xs" gap="sm">
                    <Metric
                      label={uxText('chronos_fov_board_status', locale)}
                      value={progress?.boardStatus || uxText('chronos_fov_unknown', locale)}
                      tone={
                        boardStatus === 'blocked' || boardStatus === 'failed' ? 'danger' : undefined
                      }
                    />
                    <Metric
                      label={uxText('chronos_fov_steps_active', locale)}
                      value={progress?.boardStepsActive ?? 0}
                    />
                    <Metric
                      label={uxText('chronos_fov_steps_pending', locale)}
                      value={progress?.boardStepsPending ?? 0}
                    />
                    <Metric
                      label={uxText('chronos_fov_next_tasks_pending', locale)}
                      value={progress?.nextTasksPending ?? mission.nextTaskCount}
                      description={uxMessage(
                        'chronos_fov_next_tasks_detail',
                        {
                          total: progress?.nextTasksTotal ?? mission.nextTaskCount,
                          completed: progress?.nextTasksCompleted ?? 0,
                        },
                        '{total} in queue · {completed} completed',
                        locale
                      )}
                    />
                  </Grid>

                  {onOpenMissionThread ? (
                    <ChronosToolbar>
                      <Button
                        label={uxText('chronos_fov_open_mission_thread', locale)}
                        onClick={() => onOpenMissionThread(mission.missionId)}
                      />
                    </ChronosToolbar>
                  ) : null}

                  <div className="chronos-two-col">
                    <div className="chronos-feed">
                      <h3 className="chronos-feed__title">
                        {uxText('chronos_fov_dependencies', locale)}
                      </h3>
                      {dependencies.length === 0 ? (
                        <p className="kb-text kb-text--muted">
                          {uxText('chronos_fov_no_dependencies', locale)}
                        </p>
                      ) : (
                        <List
                          items={dependencies.map((dependency) => ({
                            title: humanizeMissionId(dependency),
                            meta: dependency,
                          }))}
                        />
                      )}
                    </div>
                    <div className="chronos-feed">
                      <h3 className="chronos-feed__title">
                        {uxText('chronos_fov_latest_handoff', locale)}
                      </h3>
                      {handoffs.length === 0 ? (
                        <p className="kb-text kb-text--muted">
                          {uxText('chronos_fov_no_handoff', locale)}
                        </p>
                      ) : (
                        <>
                          <ChronosDiagram>
                            <KbChart
                              type="ui:sequence"
                              props={{
                                density: 'compact',
                                participants: Array.from(
                                  new Set(handoffs.flatMap((h) => [h.sender, h.receiver]))
                                ),
                                messages: handoffs.map((handoff) => ({
                                  from: handoff.sender,
                                  to: handoff.receiver,
                                  label:
                                    handoff.intent ||
                                    handoff.performative ||
                                    uxText('chronos_fov_handoff', locale),
                                  at: shortTime(handoff.ts),
                                })),
                              }}
                            />
                          </ChronosDiagram>
                          {latestHandoff ? (
                            <ChronosMeta>
                              {[
                                formatTimestamp(latestHandoff.ts),
                                latestHandoff.channel,
                                latestHandoff.promptExcerpt ||
                                  uxText('chronos_fov_no_prompt_excerpt', locale),
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </ChronosMeta>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="chronos-feed">
                    <h3 className="chronos-feed__title">
                      {uxText('chronos_fov_generated_assets', locale)}
                    </h3>
                    <ChronosFieldScope
                      onChange={(name, value) => {
                        if (name !== 'assetFilter' || typeof value !== 'string') return;
                        const next = assetOptions.find((option) => option.value === value);
                        if (next) setAssetFilter(next.value);
                      }}
                    >
                      <ChronosToolbar>
                        <Segmented
                          id={`asset-filter-${mission.missionId}`}
                          name="assetFilter"
                          label={uxText('chronos_fov_asset_filter', locale)}
                          hide_label
                          value={assetFilter}
                          options={assetOptions}
                        />
                      </ChronosToolbar>
                    </ChronosFieldScope>
                    {assets.length === 0 ? (
                      <EmptyState
                        title={uxText('chronos_fov_no_assets', locale)}
                        body={uxText('chronos_fov_no_assets_detail', locale)}
                      />
                    ) : (
                      <WsSelectTable
                        columns={[
                          { key: 'path', label: uxText('chronos_fov_col_asset', locale) },
                          {
                            key: 'category',
                            label: uxText('chronos_fov_col_category', locale),
                            width: '8rem',
                          },
                          {
                            key: 'size',
                            label: uxText('chronos_fov_col_size', locale),
                            width: '6rem',
                            align: 'end',
                          },
                          {
                            key: 'updated',
                            label: uxText('chronos_fov_col_updated', locale),
                            width: '11rem',
                          },
                        ]}
                        rows={assets}
                        rowKey={(asset) => asset.path}
                        onSelect={(path) =>
                          window.open(
                            missionAssetUrl(mission.missionId, path),
                            '_blank',
                            'noopener,noreferrer'
                          )
                        }
                        renderCell={(asset, key, select) => {
                          if (key === 'path') {
                            return (
                              <WsTitleCell
                                title={asset.path.split('/').slice(-1)[0] || asset.path}
                                id={asset.path}
                                onSelect={select}
                              />
                            );
                          }
                          if (key === 'category') return assetCategoryLabel(asset.category, locale);
                          if (key === 'size') return formatBytes(asset.sizeBytes);
                          return formatTimestamp(asset.updatedAt);
                        }}
                        empty={uxText('chronos_fov_no_assets', locale)}
                      />
                    )}
                  </div>
                </Section>
              </div>
            );
          })
        ))}

      {viewId === 'computer-sessions' &&
        (data.computerSessions.length === 0 ? (
          <EmptyState
            title={uxText('chronos_fov_no_sessions', locale)}
            body={uxText('chronos_fov_no_sessions_detail', locale)}
          />
        ) : (
          <div className="chronos-two-col">
            <Section
              title={uxText('chronos_fov_sessions', locale)}
              description={uxText('chronos_fov_sessions_hotkeys', locale)}
              headingLevel={3}
            >
              <WsSelectTable
                columns={[
                  { key: 'id', label: uxText('chronos_fov_col_session', locale) },
                  { key: 'status', label: uxText('chronos_fov_col_status', locale), width: '8rem' },
                  {
                    key: 'actions',
                    label: uxText('chronos_fov_col_actions', locale),
                    width: '5rem',
                    align: 'end',
                  },
                ]}
                rows={data.computerSessions}
                rowKey={(session) => session.id}
                selectedKey={selectedSessionId}
                onSelect={setSelectedSessionId}
                renderCell={(session, key, select) => {
                  if (key === 'id') {
                    return (
                      <WsTitleCell
                        title={session.id}
                        id={session.kind}
                        onSelect={select}
                        selected={session.id === selectedSessionId}
                      />
                    );
                  }
                  if (key === 'status') {
                    const status = asKbStatus(session.status);
                    return status ? (
                      <StatusPill status={status} label={session.status} />
                    ) : (
                      session.status
                    );
                  }
                  return session.actionCount ?? 0;
                }}
                empty={uxText('chronos_fov_no_sessions', locale)}
              />
            </Section>
            {(() => {
              const session = data.computerSessions.find(
                (entry) =>
                  entry.id === pickDefaultSessionId(data.computerSessions, selectedSessionId)
              );
              if (!session) {
                return (
                  <EmptyState
                    title={uxText('chronos_fov_select_session', locale)}
                    body={uxText('chronos_fov_select_session_detail', locale)}
                  />
                );
              }
              const status = asKbStatus(session.status);
              return (
                <Section title={session.id} description={session.detail} headingLevel={3}>
                  <ChronosInline>
                    <Badge label={session.kind} />
                    {status ? <StatusPill status={status} label={session.status} /> : null}
                  </ChronosInline>
                  <KeyValue
                    items={[
                      ...(session.target
                        ? [
                            {
                              label: uxText('chronos_fov_target', locale),
                              value: session.target,
                              mono: true,
                            },
                          ]
                        : []),
                      {
                        label: uxText('chronos_fov_col_updated', locale),
                        value: formatTimestamp(session.updatedAt),
                      },
                      {
                        label: uxText('chronos_fov_pid', locale),
                        value: session.pid ?? '—',
                        mono: true,
                      },
                      {
                        label: uxText('chronos_fov_col_actions', locale),
                        value: session.actionCount ?? 0,
                      },
                    ]}
                  />
                  {session.metadata && Object.keys(session.metadata).length > 0 ? (
                    <Code
                      code={JSON.stringify(session.metadata, null, 2)}
                      language="json"
                      title={uxText('chronos_fov_metadata', locale)}
                    />
                  ) : null}
                  <ChronosToolbar>
                    <Button
                      label={uxText('chronos_fov_reset_session', locale)}
                      variant="ghost"
                      onClick={() => setSelectedSessionId(null)}
                    />
                  </ChronosToolbar>
                </Section>
              );
            })()}
          </div>
        ))}

      {viewId === 'runtime-topology-map' && (
        <>
          <Section
            title={uxText('chronos_fov_runtime_graph', locale)}
            description={uxText('chronos_fov_runtime_graph_detail', locale)}
          >
            {runtimeGraph.nodes.length === 0 ? (
              <EmptyState
                title={uxText('chronos_fov_no_runtime_graph', locale)}
                body={uxText('chronos_fov_no_runtime_graph_detail', locale)}
              />
            ) : (
              <ChronosDiagram>
                <KbChart
                  type="ui:flow"
                  props={{
                    stages: [
                      { id: 'surface', label: uxText('chronos_fov_stage_surface', locale) },
                      { id: 'runtime', label: uxText('chronos_fov_stage_runtime', locale) },
                      { id: 'peer', label: uxText('chronos_fov_stage_peer', locale) },
                    ],
                    nodes: runtimeGraph.nodes.map((node) => {
                      if (node.kind === 'surface') {
                        const surface = data.runtimeTopology.surfaces.find(
                          (entry) => `surface-runtime:${entry.id}` === node.id
                        );
                        return {
                          id: node.id,
                          label: node.label,
                          stage: 'surface',
                          status: surface ? (surface.running ? 'running' : 'offline') : undefined,
                          meta: surface?.kind,
                        };
                      }
                      if (node.kind === 'runtime') {
                        const runtime = data.runtimeTopology.runtimes.find(
                          (entry) => entry.agentId === node.id
                        );
                        return {
                          id: node.id,
                          label: node.label,
                          stage: 'runtime',
                          status: asKbStatus(runtime?.status),
                          meta: runtime ? `${runtime.ownerType}:${runtime.ownerId}` : undefined,
                        };
                      }
                      return { id: node.id, label: node.label, stage: 'peer' };
                    }),
                    edges: runtimeGraph.edges.map((edge) => ({
                      from: edge.from,
                      to: edge.to,
                      label: `${flowKindLabel(edge.kind, locale)} · ${edge.count}`,
                    })),
                  }}
                />
              </ChronosDiagram>
            )}
          </Section>

          <Section
            title={uxText('chronos_fov_recent_flow', locale)}
            description={uxText('chronos_fov_recent_flow_detail', locale)}
          >
            {data.runtimeTopology.flows.length === 0 ? (
              <EmptyState
                title={uxText('chronos_fov_no_flow', locale)}
                body={uxText('chronos_fov_no_flow_detail', locale)}
              />
            ) : (
              <>
                {(() => {
                  const flows = [...data.runtimeTopology.flows]
                    .sort((a, b) => a.latestAt.localeCompare(b.latestAt))
                    .slice(-10);
                  const participantIds = Array.from(
                    new Set(flows.flatMap((flow) => [flow.from, flow.to]))
                  );
                  return (
                    <ChronosDiagram>
                      <KbChart
                        type="ui:sequence"
                        props={{
                          participants: participantIds.map((id) => ({
                            id,
                            label: endpointLabel(id),
                          })),
                          messages: flows.map((flow) => ({
                            from: flow.from,
                            to: flow.to,
                            label: `${flowKindLabel(flow.kind, locale)} ×${flow.count}`,
                            at: shortTime(flow.latestAt),
                          })),
                        }}
                      />
                    </ChronosDiagram>
                  );
                })()}
                <ChronosFieldScope
                  onChange={(name, value) => {
                    if (name === 'selectedFlow' && typeof value === 'string') {
                      setSelectedFlowId(value || null);
                    }
                  }}
                >
                  <ChronosToolbar>
                    <Select
                      id="runtime-flow-select"
                      name="selectedFlow"
                      label={uxText('chronos_fov_selected_flow', locale)}
                      placeholder={uxText('chronos_fov_select_flow', locale)}
                      value={selectedFlowId || ''}
                      options={data.runtimeTopology.flows.map((flow) => ({
                        value: flow.id,
                        label: `${endpointLabel(flow.from)} → ${endpointLabel(flow.to)} · ${flowKindLabel(flow.kind, locale)} ×${flow.count}`,
                      }))}
                    />
                  </ChronosToolbar>
                </ChronosFieldScope>
                {selectedFlow ? (
                  <KeyValue
                    items={[
                      {
                        label: uxText('chronos_fov_flow_direction', locale),
                        value: `${selectedFlow.from} → ${selectedFlow.to}`,
                        mono: true,
                      },
                      {
                        label: uxText('chronos_fov_flow_kind', locale),
                        value: flowKindLabel(selectedFlow.kind, locale),
                      },
                      {
                        label: uxText('chronos_fov_flow_count', locale),
                        value: selectedFlow.count,
                      },
                      {
                        label: uxText('chronos_fov_flow_latest', locale),
                        value: formatTimestamp(selectedFlow.latestAt),
                      },
                      ...(selectedFlow.channel
                        ? [
                            {
                              label: uxText('chronos_fov_flow_channel', locale),
                              value: selectedFlow.channel,
                              mono: true,
                            },
                          ]
                        : []),
                      ...(selectedFlow.thread
                        ? [
                            {
                              label: uxText('chronos_fov_flow_thread', locale),
                              value: selectedFlow.thread,
                              mono: true,
                            },
                          ]
                        : []),
                    ]}
                  />
                ) : (
                  <p className="kb-text kb-text--muted">
                    {uxText('chronos_fov_select_flow_detail', locale)}
                  </p>
                )}
              </>
            )}
          </Section>

          <div className="chronos-two-col">
            <Section title={uxText('chronos_fov_surface_runtimes', locale)} headingLevel={3}>
              <Table
                columns={[
                  { key: 'id', label: uxText('chronos_fov_col_surface', locale), mono: true },
                  { key: 'kind', label: uxText('chronos_fov_col_kind', locale) },
                  { key: 'status', label: uxText('chronos_fov_col_status', locale) },
                ]}
                rows={data.runtimeTopology.surfaces.map((surface) => ({
                  id: surface.id,
                  kind: surface.kind,
                  status: surface.running ? 'running' : 'offline',
                }))}
                empty={uxText('chronos_fov_no_surfaces', locale)}
              />
            </Section>
            <Section title={uxText('chronos_fov_owners', locale)} headingLevel={3}>
              <Table
                columns={[
                  { key: 'id', label: uxText('chronos_fov_col_owner', locale), mono: true },
                  { key: 'type', label: uxText('chronos_fov_col_kind', locale) },
                  {
                    key: 'runtimes',
                    label: uxText('chronos_fov_col_runtimes', locale),
                    align: 'end',
                  },
                ]}
                rows={data.runtimeTopology.owners.map((owner) => ({
                  id: owner.id,
                  type: owner.type,
                  runtimes: owner.runtimeCount,
                }))}
                empty={uxText('chronos_fov_no_owners', locale)}
              />
            </Section>
          </div>
          <Section title={uxText('chronos_fov_managed_runtimes', locale)} headingLevel={3}>
            <Table
              columns={[
                { key: 'agent', label: uxText('chronos_fov_col_runtime', locale), mono: true },
                { key: 'owner', label: uxText('chronos_fov_col_owner', locale), mono: true },
                {
                  key: 'activity',
                  label: uxText('chronos_fov_col_activity', locale),
                  align: 'end',
                },
                { key: 'status', label: uxText('chronos_fov_col_status', locale) },
              ]}
              rows={data.runtimeTopology.runtimes.map((runtime) => ({
                agent: runtime.agentId,
                owner: `${runtime.ownerType}:${runtime.ownerId}`,
                activity: runtime.recentActivityCount,
                status: asKbStatus(runtime.status) || runtime.status,
              }))}
              empty={uxText('chronos_fov_no_runtimes', locale)}
            />
          </Section>
        </>
      )}

      {viewId === 'runtime-lease-doctor' &&
        (data.runtimeDoctor.length === 0 ? (
          <Callout tone="success" title={uxText('chronos_fov_no_lease_findings', locale)} />
        ) : (
          <Section title={uxText('chronos_fov_lease_findings', locale)}>
            <List
              items={data.runtimeDoctor.map((finding) => ({
                title: finding.agentId,
                meta: [
                  finding.reason,
                  `${uxText('chronos_fov_col_owner', locale)}: ${finding.ownerId}`,
                  finding.recommendedAction === 'stop_runtime'
                    ? uxText('chronos_fov_recommend_stop', locale)
                    : uxText('chronos_fov_recommend_restart', locale),
                ].join(' · '),
                status: finding.severity === 'critical' ? 'failed' : 'degraded',
                status_label:
                  finding.severity === 'critical'
                    ? uxText('chronos_fov_severity_critical', locale)
                    : uxText('chronos_fov_severity_warning', locale),
              }))}
            />
          </Section>
        ))}

      {viewId === 'recent-surface-outbox' &&
        (data.recentSurfaceOutbox.length === 0 ? (
          <EmptyState title={uxText('chronos_fov_no_outbox', locale)} />
        ) : (
          <Section title={uxText('chronos_fov_outbox', locale)}>
            <List
              variant="timeline"
              items={data.recentSurfaceOutbox.map((message) => ({
                title: message.text,
                meta: [
                  message.surface,
                  message.channel,
                  new Date(message.created_at).toLocaleString(chronosSpeechLocale()),
                ].join(' · '),
              }))}
            />
          </Section>
        ))}

      {viewId === 'secret-approval-queue' &&
        (data.secretApprovals.length === 0 ? (
          <Callout tone="success" title={uxText('chronos_fov_no_secret_approvals', locale)} />
        ) : (
          data.secretApprovals.map((request) => (
            <Section
              key={request.id}
              title={request.title}
              description={request.summary}
              headingLevel={3}
            >
              <ChronosInline>
                <Badge
                  label={riskLabel(request.riskLevel, locale)}
                  tone={RISK_TONE[request.riskLevel]}
                />
                <ChronosMeta mono>
                  {request.serviceId} · {request.secretKey} · {request.mutation}
                </ChronosMeta>
              </ChronosInline>
              <KeyValue
                items={[
                  {
                    label: uxText('chronos_fov_storage_channel', locale),
                    value: request.storageChannel,
                    mono: true,
                  },
                  {
                    label: uxText('chronos_fov_requested_by', locale),
                    value: request.requestedBy,
                    mono: true,
                  },
                  {
                    label: uxText('chronos_fov_requested_at', locale),
                    value: formatTimestamp(request.requestedAt),
                  },
                  {
                    label: uxText('chronos_fov_strong_auth', locale),
                    value: request.requiresStrongAuth
                      ? uxText('chronos_fov_required', locale)
                      : uxText('chronos_fov_not_required', locale),
                  },
                  {
                    label: uxText('chronos_fov_col_kind', locale),
                    value: request.kind || 'secret_mutation',
                    mono: true,
                  },
                  {
                    label: uxText('chronos_fov_pending_roles', locale),
                    value: request.pendingRoles.length
                      ? request.pendingRoles.join(', ')
                      : uxText('chronos_fov_none', locale),
                    mono: true,
                  },
                  {
                    label: uxText('chronos_fov_approval_id', locale),
                    value: request.id,
                    mono: true,
                  },
                ]}
              />
              {request.phase === 'apply_pending' ? (
                <Callout
                  tone="info"
                  title={uxText('chronos_fov_apply_pending', locale)}
                  body={uxText('chronos_fov_apply_pending_detail', locale)}
                >
                  <ChronosToolbar>
                    <Button
                      label={uxText('chronos_fov_open_secret_introduce', locale)}
                      onClick={openConciergeSecretIntroduce}
                    />
                  </ChronosToolbar>
                </Callout>
              ) : (
                <Callout
                  tone="info"
                  title={uxText('chronos_fov_terminal_approval', locale)}
                  body={uxText('chronos_fov_terminal_approval_detail', locale)}
                >
                  <Code code={`pnpm kyberion approve ${request.id}`} language="shell" />
                </Callout>
              )}
            </Section>
          ))
        ))}

      {viewId === 'trace-viewer' && (
        <TraceViewer
          autoOpenRawTrace
          tenant={tenant}
          organizationId={organizationId}
          projectId={projectId}
        />
      )}

      {viewId === 'owner-summaries' && (
        <div className="chronos-two-col">
          <Section title={uxText('chronos_fov_owner_summaries', locale)} headingLevel={3}>
            <Table
              columns={[
                { key: 'mission', label: uxText('chronos_fov_col_mission', locale), mono: true },
                {
                  key: 'accepted',
                  label: uxText('chronos_fov_col_accepted', locale),
                  align: 'end',
                },
                {
                  key: 'reviewed',
                  label: uxText('chronos_fov_col_reviewed', locale),
                  align: 'end',
                },
                {
                  key: 'completed',
                  label: uxText('chronos_fov_col_completed', locale),
                  align: 'end',
                },
              ]}
              rows={data.ownerSummaries.map((summary) => ({
                mission: summary.mission_id,
                accepted: summary.accepted_count,
                reviewed: summary.reviewed_count,
                completed: summary.completed_count,
              }))}
              empty={uxText('chronos_fov_no_owner_summaries', locale)}
            />
          </Section>
          <Section title={uxText('chronos_fov_recent_events', locale)} headingLevel={3}>
            {data.recentEvents.length === 0 ? (
              <p className="kb-text kb-text--muted">{uxText('chronos_fov_no_events', locale)}</p>
            ) : (
              <List
                variant="timeline"
                items={data.recentEvents.map((event) => ({
                  title: event.decision,
                  meta: [
                    event.mission_id || uxText('chronos_fov_system', locale),
                    formatTimestamp(event.ts),
                  ].join(' · '),
                }))}
              />
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
