'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Code,
  Disclosure,
  EmptyState,
  KbChart,
  KeyValue,
  List,
  Section,
  Select,
  Skeleton,
  Stack,
  StatusPill,
  TextField,
} from '@agent/shared-ui';
import {
  isJsonRecord,
  optionalStringField,
  parseJsonValue,
  parseJsonRecord,
  recordField,
} from '../lib/json-record';
import { useChronosLocale } from '../lib/hooks';
import { chronosSpeechLocale, uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import {
  ChronosDiagram,
  ChronosFieldScope,
  ChronosInline,
  ChronosMeta,
  ChronosToolbar,
} from './chronos-ui';
import { WsSelectTable, WsTitleCell } from './ChronosWsParts';
import {
  parseTraceDetailResponse,
  parseTraceFeedResponse,
  type TraceDetailRecord,
  type TraceFeedRecord,
  type TraceFeedResponse,
  type TraceSpanDetail,
} from '../lib/trace-response';

type TraceFilters = {
  status: 'all' | TraceFeedRecord['status'];
  missionId: string;
  pipelineId: string;
  actuator: string;
  query: string;
};

type TraceSort = 'error-first' | 'newest' | 'oldest' | 'largest';

const DEFAULT_FILTERS: TraceFilters = {
  status: 'all',
  missionId: '',
  pipelineId: '',
  actuator: '',
  query: '',
};

const DEFAULT_SORT: TraceSort = 'error-first';
const TRACE_VIEWER_PREFS_KEY = 'chronos.trace-viewer.prefs';

function formatTs(value?: string): string {
  if (!value) return '—';
  const ts = new Date(value);
  return Number.isNaN(ts.getTime()) ? value : ts.toLocaleString(chronosSpeechLocale());
}

function gapPhaseBreakdown(span: TraceSpanDetail): Array<{ phase: string; ms: number }> {
  const event = span.events.find((entry) => entry.name === 'gap_phases');
  const raw = event?.attributes?.gap_phases;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = parseJsonValue(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is { phase: string; ms: number } => {
      const record = recordField(entry);
      return (
        isJsonRecord(entry) &&
        typeof record.phase === 'string' &&
        typeof record.ms === 'number' &&
        Number.isFinite(record.ms)
      );
    });
  } catch {
    return [];
  }
}

export function buildTraceFeedUrl(
  limit: number,
  filters: TraceFilters,
  refreshTick: number,
  scope: { tenant?: string; organizationId?: string; projectId?: string } = {}
): string {
  const params = new URLSearchParams({
    limit: String(limit),
    _: String(refreshTick),
  });
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.missionId.trim()) params.set('missionId', filters.missionId.trim());
  if (filters.pipelineId.trim()) params.set('pipelineId', filters.pipelineId.trim());
  if (filters.actuator.trim()) params.set('actuator', filters.actuator.trim());
  if (filters.query.trim()) params.set('query', filters.query.trim());
  if (scope.tenant) params.set('tenant', scope.tenant);
  if (scope.organizationId) params.set('organization_id', scope.organizationId);
  if (scope.projectId) params.set('project_id', scope.projectId);
  return `/api/traces?${params.toString()}`;
}

export function focusTraceRecord(rawText: string, traceId?: string | null): string {
  const needle = traceId?.trim();
  if (!needle) return rawText;

  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseJsonRecord(trimmed);
      if (parsed && optionalStringField(parsed, 'traceId') === needle) {
        return `${JSON.stringify(parsed, null, 2)}\n`;
      }
    } catch {
      // Fall through to raw text.
    }
  }

  return rawText;
}

export function buildTraceFocusHistory(
  history: string[],
  traceId?: string | null,
  limit = 5
): string[] {
  const next = traceId?.trim();
  if (!next) return history.slice(0, limit);
  return [next, ...history.filter((entry) => entry !== next)].slice(0, limit);
}

export function resolveTraceHotkeySelection(
  traces: TraceFeedRecord[],
  currentTraceId: string | null,
  key: string
): string | null {
  const normalized = key.toLowerCase();
  const index = Number.parseInt(normalized, 10);
  if (Number.isInteger(index) && index >= 1 && index <= 9) {
    return traces[index - 1]?.traceId || null;
  }

  if (traces.length === 0) return null;
  const currentIndex = currentTraceId
    ? traces.findIndex((trace) => trace.traceId === currentTraceId)
    : -1;
  if (normalized === 'j') {
    return (
      traces[Math.min(traces.length - 1, currentIndex + 1 >= 0 ? currentIndex + 1 : 0)]?.traceId ||
      traces[0]?.traceId ||
      null
    );
  }
  if (normalized === 'k') {
    if (currentIndex <= 0) return traces[0]?.traceId || null;
    return traces[currentIndex - 1]?.traceId || traces[0]?.traceId || null;
  }
  return null;
}

function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
    (element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.tagName === 'SELECT' ||
      element.isContentEditable)
  );
}

export function shouldOpenRawTracePanel(input: {
  autoOpenRawTrace: boolean;
  rawTraceVisible: boolean;
  rawTraceLoadedTraceId: string | null;
  selectedTraceId: string | null;
  selectedTracePath?: string | null;
  rawTraceLoading: boolean;
}): boolean {
  if (!input.selectedTraceId || !input.selectedTracePath) return false;
  if (input.rawTraceLoading) return false;
  if (input.rawTraceVisible) {
    return input.rawTraceLoadedTraceId !== input.selectedTraceId;
  }
  return input.autoOpenRawTrace;
}

type TraceViewerPrefs = {
  filters: TraceFilters;
  sort: TraceSort;
  selectedTraceId: string | null;
  rawTraceFocusTraceId: string;
  rawTraceFocusHistory: string[];
  rawTraceVisible: boolean;
};

function normalizeTraceFocusHistory(value: unknown, limit = 5): string[] {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const traceId = entry.trim();
    if (!traceId || next.includes(traceId)) continue;
    next.push(traceId);
    if (next.length >= limit) break;
  }
  return next;
}

function normalizeTraceFilters(value: unknown): TraceFilters {
  const filters = recordField(value);
  const status = filters.status;
  return {
    status: status === 'ok' || status === 'error' || status === 'in_progress' ? status : 'all',
    missionId: optionalStringField(filters, 'missionId') || '',
    pipelineId: optionalStringField(filters, 'pipelineId') || '',
    actuator: optionalStringField(filters, 'actuator') || '',
    query: optionalStringField(filters, 'query') || '',
  };
}

export function loadTraceViewerPrefs(rawValue?: string | null): TraceViewerPrefs | null {
  const raw =
    rawValue ??
    (typeof window === 'undefined' ? null : window.localStorage.getItem(TRACE_VIEWER_PREFS_KEY));
  if (!raw) return null;
  try {
    const parsed = parseJsonRecord(raw);
    if (!parsed) return null;
    return {
      filters: normalizeTraceFilters(parsed.filters),
      sort:
        parsed.sort === 'error-first' ||
        parsed.sort === 'newest' ||
        parsed.sort === 'oldest' ||
        parsed.sort === 'largest'
          ? parsed.sort
          : DEFAULT_SORT,
      selectedTraceId: optionalStringField(parsed, 'selectedTraceId') || null,
      rawTraceFocusTraceId: optionalStringField(parsed, 'rawTraceFocusTraceId') || '',
      rawTraceFocusHistory: normalizeTraceFocusHistory(parsed.rawTraceFocusHistory),
      rawTraceVisible: typeof parsed.rawTraceVisible === 'boolean' ? parsed.rawTraceVisible : false,
    };
  } catch {
    return null;
  }
}

function saveTraceViewerPrefs(prefs: TraceViewerPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRACE_VIEWER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be denied; ignore.
  }
}

/** Trace / span state → canonical `ui:status-pill` status. */
const TRACE_STATUS: Record<TraceFeedRecord['status'], KbStatus> = {
  ok: 'done',
  error: 'failed',
  in_progress: 'running',
};

const SPAN_FLOW_NODE_LIMIT = 24;

function spanDurationMs(span: TraceSpanDetail): number | null {
  if (!span.endTime) return null;
  const start = new Date(span.startTime).getTime();
  const end = new Date(span.endTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** The span tree as `ui:flow` nodes / edges (breadth-first, capped). */
function buildSpanFlow(root: TraceSpanDetail): {
  nodes: Array<{ id: string; label: string; status: KbStatus; meta?: string }>;
  edges: Array<{ from: string; to: string }>;
} {
  const nodes: Array<{ id: string; label: string; status: KbStatus; meta?: string }> = [];
  const edges: Array<{ from: string; to: string }> = [];
  const queue: Array<{ span: TraceSpanDetail; id: string; parent: string | null }> = [
    { span: root, id: 'span-0', parent: null },
  ];
  while (queue.length > 0 && nodes.length < SPAN_FLOW_NODE_LIMIT) {
    const { span, id, parent } = queue.shift()!;
    const duration = spanDurationMs(span);
    nodes.push({
      id,
      label: span.name,
      status: TRACE_STATUS[span.status],
      meta: duration === null ? undefined : `${duration} ms`,
    });
    if (parent) edges.push({ from: parent, to: id });
    span.children.forEach((child, index) => {
      queue.push({ span: child, id: `${id}.${index}`, parent: id });
    });
  }
  return { nodes, edges };
}

function traceStatusOptions(locale: SupportedLocale) {
  return [
    { value: 'all', label: uxText('chronos_trace_all_statuses', locale) },
    { value: 'ok', label: uxText('chronos_trace_status_ok', locale) },
    { value: 'error', label: uxText('chronos_trace_status_error', locale) },
    { value: 'in_progress', label: uxText('chronos_trace_status_in_progress', locale) },
  ];
}

function traceSortOptions(locale: SupportedLocale): Array<{ value: TraceSort; label: string }> {
  return [
    { value: 'error-first', label: uxText('chronos_trace_sort_error_first', locale) },
    { value: 'newest', label: uxText('chronos_trace_sort_newest', locale) },
    { value: 'oldest', label: uxText('chronos_trace_sort_oldest', locale) },
    { value: 'largest', label: uxText('chronos_trace_sort_largest', locale) },
  ];
}

function TraceSpanTree({
  span,
  depth = 0,
  onCopy,
  locale,
}: {
  span: TraceSpanDetail;
  depth?: number;
  onCopy: (value: string, label: string) => Promise<void> | void;
  locale: SupportedLocale;
}) {
  const previewEvents = span.events.slice(0, 3);
  const previewArtifacts = span.artifacts.slice(0, 3);
  const gapPhases = gapPhaseBreakdown(span);
  const attributes = span.attributes ? Object.entries(span.attributes) : [];

  return (
    <Stack gap="sm">
      <ChronosInline>
        <strong>{span.name}</strong>
        <StatusPill status={TRACE_STATUS[span.status]} />
        <ChronosMeta mono>
          {span.spanId || uxText('chronos_trace_no_span_id', locale)} · {formatTs(span.startTime)}
          {span.endTime ? ` → ${formatTs(span.endTime)}` : ''}
        </ChronosMeta>
      </ChronosInline>
      <ChronosMeta>
        {uxMessage(
          'chronos_trace_span_counts',
          {
            events: span.events.length,
            artifacts: span.artifacts.length,
            children: span.children.length,
          },
          '{events} events · {artifacts} artifacts · {children} child spans',
          locale
        )}
      </ChronosMeta>
      {span.error ? <Callout tone="danger" title={span.error} /> : null}

      {attributes.length > 0 ? (
        <KeyValue
          items={attributes.map(([key, value]) => ({
            label: key,
            value: String(value),
            mono: true,
          }))}
        />
      ) : null}

      {gapPhases.length > 0 ? (
        <Disclosure summary={uxText('chronos_trace_gap_breakdown', locale)} open={depth === 0}>
          <KeyValue
            items={gapPhases.map((entry) => ({
              label: entry.phase,
              value: `${entry.ms} ms`,
              mono: true,
            }))}
          />
        </Disclosure>
      ) : null}

      {span.knowledgeRefs.length > 0 ? (
        <Disclosure
          summary={uxMessage(
            'chronos_trace_refs_summary',
            { count: span.knowledgeRefs.length },
            'Knowledge refs ({count})',
            locale
          )}
          open={depth === 0}
        >
          <List items={span.knowledgeRefs.slice(0, 4).map((ref) => ({ title: ref }))} />
          <ChronosToolbar>
            <Button
              label={uxText('chronos_trace_copy_refs', locale)}
              variant="ghost"
              onClick={() =>
                void onCopy(
                  span.knowledgeRefs.join('\n'),
                  uxText('chronos_trace_label_refs', locale)
                )
              }
            />
          </ChronosToolbar>
        </Disclosure>
      ) : null}

      {previewEvents.length > 0 ? (
        <Disclosure
          summary={uxMessage(
            'chronos_trace_events_summary',
            { count: span.events.length },
            'Events ({count})',
            locale
          )}
          open={depth === 0}
        >
          <List
            variant="timeline"
            items={previewEvents.map((event) => ({
              title: event.name,
              meta: formatTs(event.timestamp),
            }))}
          />
          {span.events.length > previewEvents.length ? (
            <ChronosMeta>
              {uxMessage(
                'chronos_trace_more',
                { count: span.events.length - previewEvents.length },
                '+{count} more',
                locale
              )}
            </ChronosMeta>
          ) : null}
          <ChronosToolbar>
            <Button
              label={uxText('chronos_trace_copy_events', locale)}
              variant="ghost"
              onClick={() =>
                void onCopy(
                  span.events
                    .map(
                      (event) =>
                        `${formatTs(event.timestamp)} ${event.name}${event.attributes ? ` ${JSON.stringify(event.attributes)}` : ''}`
                    )
                    .join('\n'),
                  uxText('chronos_trace_label_events', locale)
                )
              }
            />
          </ChronosToolbar>
        </Disclosure>
      ) : null}

      {previewArtifacts.length > 0 ? (
        <Disclosure
          summary={uxMessage(
            'chronos_trace_artifacts_summary',
            { count: span.artifacts.length },
            'Artifacts ({count})',
            locale
          )}
          open={depth === 0}
        >
          <List
            items={previewArtifacts.map((artifact) => ({
              title: artifact.description || artifact.path,
              meta: `${artifact.type} · ${formatTs(artifact.timestamp)}`,
            }))}
          />
          {span.artifacts.length > previewArtifacts.length ? (
            <ChronosMeta>
              {uxMessage(
                'chronos_trace_more',
                { count: span.artifacts.length - previewArtifacts.length },
                '+{count} more',
                locale
              )}
            </ChronosMeta>
          ) : null}
          <ChronosToolbar>
            <Button
              label={uxText('chronos_trace_copy_artifacts', locale)}
              variant="ghost"
              onClick={() =>
                void onCopy(
                  span.artifacts
                    .map(
                      (artifact) =>
                        `${formatTs(artifact.timestamp)} ${artifact.type} ${artifact.description || artifact.path}`
                    )
                    .join('\n'),
                  uxText('chronos_trace_label_artifacts', locale)
                )
              }
            />
          </ChronosToolbar>
        </Disclosure>
      ) : null}

      {span.children.length > 0 ? (
        <Disclosure
          summary={uxMessage(
            'chronos_trace_children_summary',
            { count: span.children.length },
            'Child spans ({count})',
            locale
          )}
          open={depth === 0}
        >
          <Stack gap="md">
            {span.children.map((child, index) => (
              <TraceSpanTree
                key={`${child.spanId || child.name}-${index}`}
                span={child}
                depth={depth + 1}
                onCopy={onCopy}
                locale={locale}
              />
            ))}
          </Stack>
        </Disclosure>
      ) : null}
    </Stack>
  );
}

export function TraceViewer({
  autoOpenRawTrace = false,
  tenant,
  organizationId,
  projectId,
}: {
  autoOpenRawTrace?: boolean;
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}) {
  const locale = useChronosLocale();
  const searchParams = useSearchParams();
  const activeTenant = tenant || searchParams.get('tenant') || undefined;
  const activeOrganizationId = organizationId || searchParams.get('organization_id') || undefined;
  const activeProjectId = projectId || searchParams.get('project_id') || undefined;
  const [data, setData] = useState<TraceFeedResponse | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<TraceDetailRecord | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [filters, setFilters] = useState<TraceFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<TraceSort>(DEFAULT_SORT);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [rawTraceText, setRawTraceText] = useState<string | null>(null);
  const [rawTraceLoading, setRawTraceLoading] = useState(false);
  const [rawTraceError, setRawTraceError] = useState<string | null>(null);
  const [rawTraceVisible, setRawTraceVisible] = useState(false);
  const [rawTraceFocusTraceId, setRawTraceFocusTraceId] = useState<string>('');
  const [rawTraceFocusHistory, setRawTraceFocusHistory] = useState<string[]>([]);
  const [rawTraceLoadedTraceId, setRawTraceLoadedTraceId] = useState<string | null>(null);

  useEffect(() => {
    const prefs = loadTraceViewerPrefs();
    if (!prefs) return;
    setFilters(prefs.filters);
    setSort(prefs.sort);
    setSelectedTraceId(prefs.selectedTraceId);
    setRawTraceFocusTraceId(prefs.rawTraceFocusTraceId);
    setRawTraceFocusHistory(prefs.rawTraceFocusHistory);
    setRawTraceVisible(prefs.rawTraceVisible);
  }, []);

  useEffect(() => {
    saveTraceViewerPrefs({
      filters,
      sort,
      selectedTraceId,
      rawTraceFocusTraceId,
      rawTraceFocusHistory,
      rawTraceVisible,
    });
  }, [filters, rawTraceFocusHistory, rawTraceFocusTraceId, rawTraceVisible, selectedTraceId, sort]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTraceFeed() {
      try {
        setLoadingList(true);
        setListError(null);
        const response = await fetch(
          buildTraceFeedUrl(12, filters, refreshTick, {
            tenant: activeTenant,
            organizationId: activeOrganizationId,
            projectId: activeProjectId,
          }),
          {
            signal: controller.signal,
            cache: 'no-store',
          }
        );
        if (!response.ok) {
          throw new Error(`Trace feed request failed (${response.status})`);
        }
        const payload = parseTraceFeedResponse(await response.json().catch(() => null));
        if (!payload) throw new Error('Invalid trace feed response');
        setData(payload);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setListError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingList(false);
      }
    }

    loadTraceFeed();
    return () => controller.abort();
  }, [activeOrganizationId, activeProjectId, activeTenant, filters, refreshTick]);

  useEffect(() => {
    if (!data?.traces.length) {
      setSelectedTraceId(null);
      setSelectedTrace(null);
      return;
    }

    const currentExists =
      selectedTraceId && data.traces.some((trace) => trace.traceId === selectedTraceId);
    if (!currentExists) {
      setSelectedTraceId(data.traces[0].traceId);
    }
  }, [data, selectedTraceId]);

  useEffect(() => {
    if (!selectedTraceId) {
      setSelectedTrace(null);
      return;
    }

    const controller = new AbortController();

    async function loadTraceDetail() {
      try {
        setLoadingDetail(true);
        setDetailError(null);
        const response = await fetch(
          `/api/traces?traceId=${encodeURIComponent(selectedTraceId)}&_=${refreshTick}${activeTenant ? `&tenant=${encodeURIComponent(activeTenant)}` : ''}${activeOrganizationId ? `&organization_id=${encodeURIComponent(activeOrganizationId)}` : ''}${activeProjectId ? `&project_id=${encodeURIComponent(activeProjectId)}` : ''}`,
          {
            signal: controller.signal,
            cache: 'no-store',
          }
        );
        if (!response.ok) {
          throw new Error(`Trace detail request failed (${response.status})`);
        }
        const payload = parseTraceDetailResponse(await response.json().catch(() => null));
        if (!payload) throw new Error('Invalid trace detail response');
        setSelectedTrace(payload.trace);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setDetailError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingDetail(false);
      }
    }

    loadTraceDetail();
    return () => controller.abort();
  }, [activeOrganizationId, activeProjectId, activeTenant, refreshTick, selectedTraceId]);

  useEffect(() => {
    if (
      !shouldOpenRawTracePanel({
        autoOpenRawTrace,
        rawTraceVisible,
        rawTraceLoadedTraceId,
        rawTraceLoading,
        selectedTraceId,
        selectedTracePath: selectedTrace?.tracePath,
      })
    ) {
      return;
    }
    void openRawTraceFile(selectedTrace.tracePath, rawTraceFocusTraceId || selectedTrace.traceId);
  }, [
    autoOpenRawTrace,
    rawTraceFocusTraceId,
    rawTraceLoadedTraceId,
    rawTraceLoading,
    rawTraceVisible,
    selectedTraceId,
    selectedTrace,
  ]);

  const traces = data?.traces ?? [];
  const visibleTraces = useMemo(
    () =>
      [...traces].sort((a, b) => {
        if (sort === 'newest') return b.persistedAt.localeCompare(a.persistedAt);
        if (sort === 'oldest') return a.persistedAt.localeCompare(b.persistedAt);
        if (sort === 'largest') {
          const countDelta = b.spanCount - a.spanCount;
          if (countDelta !== 0) return countDelta;
          const errorDelta = b.errorCount - a.errorCount;
          if (errorDelta !== 0) return errorDelta;
          return b.persistedAt.localeCompare(a.persistedAt);
        }

        const errorDelta = b.errorCount - a.errorCount;
        if (errorDelta !== 0) return errorDelta;

        const statusRank = (status: TraceFeedRecord['status']): number => {
          switch (status) {
            case 'error':
              return 0;
            case 'in_progress':
              return 1;
            default:
              return 2;
          }
        };

        const statusDelta = statusRank(a.status) - statusRank(b.status);
        if (statusDelta !== 0) return statusDelta;

        return b.persistedAt.localeCompare(a.persistedAt);
      }),
    [sort, traces]
  );
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableHotkeyTarget(event.target)) return;
      if (!visibleTraces.length) return;

      const normalized = event.key.toLowerCase();
      if (normalized === 'r') {
        event.preventDefault();
        setRawTraceVisible((current) => !current);
        return;
      }

      const nextTraceId = resolveTraceHotkeySelection(visibleTraces, selectedTraceId, event.key);
      if (!nextTraceId) return;
      event.preventDefault();
      setSelectedTraceId(nextTraceId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTraceId, visibleTraces]);
  const selectedSummary = useMemo(
    () =>
      visibleTraces.find((trace) => trace.traceId === selectedTraceId) || visibleTraces[0] || null,
    [selectedTraceId, visibleTraces]
  );
  const missionOptions = useMemo(
    () => [
      ...new Set(
        visibleTraces
          .map((trace) => trace.missionId)
          .filter((value): value is string => Boolean(value))
      ),
    ],
    [visibleTraces]
  );
  const actuatorOptions = useMemo(
    () => [
      ...new Set(
        visibleTraces
          .map((trace) => trace.actuator)
          .filter((value): value is string => Boolean(value))
      ),
    ],
    [visibleTraces]
  );

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      const copied = uxMessage('chronos_trace_copied', { label }, 'Copied {label}', locale);
      setCopiedValue(copied);
      window.setTimeout(
        () => setCopiedValue((current) => (current === copied ? null : current)),
        1600
      );
    } catch {
      setCopiedValue(
        uxMessage('chronos_trace_copy_failed', { label }, 'Copy failed: {label}', locale)
      );
      window.setTimeout(() => setCopiedValue(null), 1600);
    }
  }

  async function openRawTraceFile(tracePath: string, traceId?: string): Promise<void> {
    const path = tracePath.trim();
    if (!path) return;
    const focusTraceId = traceId?.trim() || selectedTraceId || '';
    setRawTraceLoadedTraceId(selectedTraceId);
    setRawTraceVisible(true);
    setRawTraceLoading(true);
    setRawTraceError(null);
    setRawTraceText(null);
    setRawTraceFocusTraceId(focusTraceId);
    setRawTraceFocusHistory((current) => buildTraceFocusHistory(current, focusTraceId));
    try {
      const response = await fetch(`/api/trace-log?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || `Trace log request failed (${response.status})`);
      }
      setRawTraceText(focusTraceRecord(text, focusTraceId));
    } catch (err) {
      setRawTraceError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawTraceLoading(false);
    }
  }

  async function refocusRawTraceFile(traceId?: string): Promise<void> {
    if (!selectedTrace?.tracePath) return;
    await openRawTraceFile(selectedTrace.tracePath, traceId || rawTraceFocusTraceId);
  }

  function resetTraceViewerPrefs(): void {
    setFilters(DEFAULT_FILTERS);
    setSort(DEFAULT_SORT);
    setSelectedTraceId(null);
    setRawTraceFocusTraceId('');
    setRawTraceFocusHistory([]);
    setRawTraceVisible(false);
  }

  function handleFieldChange(name: string, value: unknown): void {
    const text = typeof value === 'string' ? value : '';
    if (name === 'query') setFilters((current) => ({ ...current, query: text }));
    else if (name === 'status') {
      setFilters((current) => ({
        ...current,
        status:
          text === 'ok' || text === 'error' || text === 'in_progress'
            ? (text as TraceFilters['status'])
            : 'all',
      }));
    } else if (name === 'missionId') setFilters((current) => ({ ...current, missionId: text }));
    else if (name === 'actuator') setFilters((current) => ({ ...current, actuator: text }));
    else if (name === 'sort') {
      const next = traceSortOptions(locale).find((option) => option.value === text);
      if (next) setSort(next.value);
    } else if (name === 'rawTraceFocus') setRawTraceFocusTraceId(text);
  }

  const refresh = () => setRefreshTick((value) => value + 1);
  const spanFlow = selectedTrace ? buildSpanFlow(selectedTrace.rootSpan) : null;

  return (
    <Section
      title={uxText('chronos_trace_title', locale)}
      description={uxText('chronos_trace_description', locale)}
    >
      <ChronosFieldScope onChange={handleFieldChange}>
        <ChronosToolbar>
          <TextField
            id="trace-query"
            name="query"
            type="search"
            label={uxText('chronos_trace_search', locale)}
            placeholder={uxText('chronos_trace_search_placeholder', locale)}
            value={filters.query}
          />
          <Select
            id="trace-status"
            name="status"
            label={uxText('chronos_trace_filter_status', locale)}
            value={filters.status}
            options={traceStatusOptions(locale)}
          />
          <Select
            id="trace-mission"
            name="missionId"
            label={uxText('chronos_trace_filter_mission', locale)}
            value={filters.missionId}
            options={[
              { value: '', label: uxText('chronos_ac_filter_all_missions', locale) },
              ...missionOptions.map((missionId) => ({ value: missionId, label: missionId })),
            ]}
          />
          <Select
            id="trace-actuator"
            name="actuator"
            label={uxText('chronos_trace_filter_actuator', locale)}
            value={filters.actuator}
            options={[
              { value: '', label: uxText('chronos_trace_all_actuators', locale) },
              ...actuatorOptions.map((actuator) => ({ value: actuator, label: actuator })),
            ]}
          />
          <Select
            id="trace-sort"
            name="sort"
            label={uxText('chronos_trace_sort', locale)}
            value={sort}
            options={traceSortOptions(locale)}
          />
          <Button
            label={uxText('chronos_trace_reset', locale)}
            variant="ghost"
            onClick={resetTraceViewerPrefs}
          />
          <Button label={uxText('chronos_refresh', locale)} onClick={refresh} />
        </ChronosToolbar>
      </ChronosFieldScope>
      <ChronosMeta>{uxText('chronos_trace_hotkeys', locale)}</ChronosMeta>

      <div className="chronos-two-col">
        <div className="chronos-feed">
          <h3 className="chronos-feed__title">{uxText('chronos_trace_feed', locale)}</h3>
          {loadingList ? (
            <Skeleton
              shape="table"
              lines={4}
              label={uxText('chronos_trace_loading_feed', locale)}
            />
          ) : null}
          {listError ? (
            <Callout
              tone="danger"
              title={uxText('chronos_trace_feed_failed', locale)}
              body={listError}
            >
              <ChronosToolbar>
                <Button label={uxText('chronos_action_retry', locale)} onClick={refresh} />
              </ChronosToolbar>
            </Callout>
          ) : null}
          {!loadingList && !listError && traces.length === 0 ? (
            <Callout
              tone="warning"
              title={uxText('chronos_trace_no_matches', locale)}
              body={uxMessage(
                'chronos_trace_no_matches_detail',
                { dir: data?.traceDir ?? 'active/shared/logs/traces' },
                'Try clearing the filters or refreshing. The trace directory is {dir}.',
                locale
              )}
            >
              <ChronosToolbar>
                <Button
                  label={uxText('chronos_trace_reset_filters', locale)}
                  onClick={resetTraceViewerPrefs}
                />
                <Button
                  label={uxText('chronos_refresh', locale)}
                  variant="ghost"
                  onClick={refresh}
                />
              </ChronosToolbar>
            </Callout>
          ) : null}
          {visibleTraces.length > 0 ? (
            <WsSelectTable
              columns={[
                { key: 'trace', label: uxText('chronos_trace_col_trace', locale) },
                { key: 'status', label: uxText('chronos_trace_col_status', locale), width: '7rem' },
                {
                  key: 'spans',
                  label: uxText('chronos_trace_col_spans', locale),
                  width: '4.5rem',
                  align: 'end',
                },
                {
                  key: 'errors',
                  label: uxText('chronos_trace_col_errors', locale),
                  width: '4.5rem',
                  align: 'end',
                },
                { key: 'persisted', label: uxText('chronos_trace_col_persisted', locale) },
              ]}
              rows={visibleTraces}
              rowKey={(trace) => trace.traceId}
              selectedKey={selectedTraceId}
              onSelect={setSelectedTraceId}
              renderCell={(trace, key, select) => {
                if (key === 'trace') {
                  return (
                    <WsTitleCell
                      title={trace.rootSpanName}
                      id={[trace.traceId, trace.missionId, trace.pipelineId, trace.actuator]
                        .filter(Boolean)
                        .join(' · ')}
                      onSelect={select}
                      selected={trace.traceId === selectedTraceId}
                    />
                  );
                }
                if (key === 'status') return <StatusPill status={TRACE_STATUS[trace.status]} />;
                if (key === 'spans') return trace.spanCount;
                if (key === 'errors') return trace.errorCount;
                return formatTs(trace.persistedAt);
              }}
              empty={uxText('chronos_trace_no_matches', locale)}
            />
          ) : null}
        </div>

        <div className="chronos-feed">
          <h3 className="chronos-feed__title">
            {selectedSummary?.rootSpanName ?? uxText('chronos_trace_selected', locale)}
          </h3>

          {loadingDetail ? (
            <Skeleton
              shape="card"
              lines={3}
              label={uxText('chronos_trace_loading_detail', locale)}
            />
          ) : null}
          {detailError ? (
            <Callout
              tone="danger"
              title={uxText('chronos_trace_detail_failed', locale)}
              body={detailError}
            >
              <ChronosToolbar>
                <Button label={uxText('chronos_action_retry', locale)} onClick={refresh} />
              </ChronosToolbar>
            </Callout>
          ) : null}

          {selectedTrace ? (
            <Stack gap="md">
              <ChronosInline>
                <StatusPill status={TRACE_STATUS[selectedTrace.status]} />
                {selectedTrace.actuator ? <Badge label={selectedTrace.actuator} /> : null}
                {selectedTrace.errorCount > 0 ? (
                  <Badge
                    tone="danger"
                    label={uxMessage(
                      'chronos_trace_error_count',
                      { count: selectedTrace.errorCount },
                      '{count} errors',
                      locale
                    )}
                  />
                ) : null}
              </ChronosInline>

              <KeyValue
                items={[
                  {
                    label: uxText('chronos_trace_trace_id', locale),
                    value: selectedTrace.traceId,
                    mono: true,
                  },
                  ...(selectedTrace.missionId
                    ? [
                        {
                          label: uxText('chronos_trace_filter_mission', locale),
                          value: selectedTrace.missionId,
                          mono: true,
                        },
                      ]
                    : []),
                  ...(selectedTrace.pipelineId
                    ? [
                        {
                          label: uxText('chronos_trace_pipeline', locale),
                          value: selectedTrace.pipelineId,
                          mono: true,
                        },
                      ]
                    : []),
                  {
                    label: uxText('chronos_trace_root_span', locale),
                    value: selectedTrace.rootSpan.name,
                  },
                  {
                    label: uxText('chronos_trace_counts', locale),
                    value: uxMessage(
                      'chronos_trace_counts_value',
                      {
                        spans: selectedTrace.spanCount,
                        events: selectedTrace.eventCount,
                        artifacts: selectedTrace.artifactCount,
                        errors: selectedTrace.errorCount,
                      },
                      '{spans} spans · {events} events · {artifacts} artifacts · {errors} errors',
                      locale
                    ),
                  },
                  {
                    label: uxText('chronos_trace_started', locale),
                    value: formatTs(selectedTrace.startedAt),
                  },
                  {
                    label: uxText('chronos_trace_col_persisted', locale),
                    value: formatTs(selectedTrace.persistedAt),
                  },
                  {
                    label: uxText('chronos_trace_path', locale),
                    value: selectedTrace.tracePath,
                    mono: true,
                  },
                ]}
              />

              <ChronosToolbar>
                <Button
                  label={uxText('chronos_trace_copy_id', locale)}
                  variant="ghost"
                  onClick={() =>
                    void copyText(selectedTrace.traceId, uxText('chronos_trace_trace_id', locale))
                  }
                />
                <Button
                  label={uxText('chronos_trace_copy_path', locale)}
                  variant="ghost"
                  onClick={() =>
                    void copyText(selectedTrace.tracePath, uxText('chronos_trace_path', locale))
                  }
                />
                {copiedValue ? <ChronosMeta>{copiedValue}</ChronosMeta> : null}
              </ChronosToolbar>

              {spanFlow && spanFlow.nodes.length > 1 ? (
                <ChronosDiagram>
                  <KbChart
                    type="ui:flow"
                    props={{
                      title: uxText('chronos_trace_span_flow', locale),
                      density: 'compact',
                      nodes: spanFlow.nodes,
                      edges: spanFlow.edges,
                    }}
                  />
                </ChronosDiagram>
              ) : null}

              <ChronosToolbar>
                <Button
                  label={uxText('chronos_trace_open_raw', locale)}
                  variant="primary"
                  onClick={() =>
                    void openRawTraceFile(selectedTrace.tracePath, selectedTrace.traceId)
                  }
                />
                <Button
                  label={uxText('chronos_trace_copy_focused', locale)}
                  variant="ghost"
                  disabled={!rawTraceText}
                  onClick={() =>
                    void copyText(rawTraceText || '', uxText('chronos_trace_label_focused', locale))
                  }
                />
                <Button
                  label={
                    rawTraceVisible
                      ? uxText('chronos_trace_hide_raw', locale)
                      : uxText('chronos_trace_show_raw', locale)
                  }
                  variant="ghost"
                  onClick={() => setRawTraceVisible((value) => !value)}
                />
              </ChronosToolbar>

              {rawTraceVisible ? (
                <Stack gap="sm">
                  {rawTraceFocusHistory.length > 1 ? (
                    <ChronosInline>
                      <ChronosMeta>{uxText('chronos_trace_recent_focus', locale)}</ChronosMeta>
                      {rawTraceFocusHistory.map((traceId) => (
                        <Button
                          key={traceId}
                          label={traceId}
                          variant={traceId === rawTraceFocusTraceId ? 'secondary' : 'ghost'}
                          onClick={() => {
                            setRawTraceFocusTraceId(traceId);
                            void refocusRawTraceFile(traceId);
                          }}
                        />
                      ))}
                    </ChronosInline>
                  ) : null}
                  <ChronosFieldScope onChange={handleFieldChange}>
                    <ChronosToolbar>
                      <TextField
                        id="trace-raw-focus"
                        name="rawTraceFocus"
                        label={uxText('chronos_trace_trace_id', locale)}
                        placeholder={selectedTrace.traceId}
                        value={rawTraceFocusTraceId}
                      />
                      <Button
                        label={uxText('chronos_trace_refocus', locale)}
                        onClick={() => void refocusRawTraceFile()}
                      />
                    </ChronosToolbar>
                  </ChronosFieldScope>
                  {rawTraceLoading ? (
                    <Skeleton
                      shape="text"
                      lines={6}
                      label={uxText('chronos_trace_loading_raw', locale)}
                    />
                  ) : rawTraceError ? (
                    <Callout
                      tone="danger"
                      title={uxText('chronos_trace_raw_failed', locale)}
                      body={rawTraceError}
                    />
                  ) : rawTraceText ? (
                    <Code
                      code={rawTraceText}
                      language="json"
                      title={uxText('chronos_trace_raw_log', locale)}
                    />
                  ) : (
                    <Callout
                      tone="info"
                      title={uxText('chronos_trace_raw_hint', locale)}
                      body={uxText('chronos_trace_raw_hint_detail', locale)}
                    />
                  )}
                </Stack>
              ) : null}

              <Section title={uxText('chronos_trace_span_tree', locale)} headingLevel={4}>
                <TraceSpanTree span={selectedTrace.rootSpan} onCopy={copyText} locale={locale} />
              </Section>
            </Stack>
          ) : loadingDetail ? null : (
            <Stack gap="sm">
              <EmptyState
                title={uxText('chronos_trace_none_selected', locale)}
                body={uxText('chronos_trace_none_selected_detail', locale)}
              />
              <ChronosToolbar>
                <Button
                  label={uxText('chronos_trace_reset_filters', locale)}
                  variant="ghost"
                  onClick={resetTraceViewerPrefs}
                />
              </ChronosToolbar>
            </Stack>
          )}
        </div>
      </div>
    </Section>
  );
}
