'use client';

import { Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';
import { SurfaceStatusPanel } from './SurfaceStatusPanel';

type TraceFeedRecord = {
  traceId: string;
  tracePath: string;
  persistedAt: string;
  startedAt: string;
  completedAt?: string;
  missionId?: string;
  pipelineId?: string;
  actuator?: string;
  status: 'ok' | 'error' | 'in_progress';
  rootSpanName: string;
  spanCount: number;
  eventCount: number;
  artifactCount: number;
  errorCount: number;
  rootSpan: {
    spanId?: string;
    name: string;
    status: 'ok' | 'error' | 'in_progress';
    startTime: string;
    endTime?: string;
    attributes?: Record<string, string | number | boolean>;
    events: number;
    artifacts: number;
    children: number;
  };
};

type TraceSpanDetail = {
  spanId?: string;
  name: string;
  status: 'ok' | 'error' | 'in_progress';
  startTime: string;
  endTime?: string;
  attributes?: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    timestamp: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
  artifacts: Array<{
    type: 'screenshot' | 'file' | 'document' | 'log';
    path: string;
    description?: string;
    timestamp: string;
  }>;
  knowledgeRefs: string[];
  error?: string;
  children: TraceSpanDetail[];
};

type TraceDetailRecord = TraceFeedRecord & {
  rootSpan: TraceSpanDetail;
};

type TraceFeedResponse = {
  traces: TraceFeedRecord[];
  traceDir: string;
};

type TraceDetailResponse = {
  trace: TraceDetailRecord | null;
  traceDir: string;
};

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
  if (!value) return 'n/a';
  const ts = new Date(value);
  return Number.isNaN(ts.getTime()) ? value : ts.toLocaleString(chronosSpeechLocale());
}

function statusTone(status: TraceFeedRecord['status']): string {
  switch (status) {
    case 'error':
      return 'kb-status-negative-border kb-status-negative-surface kb-status-negative';
    case 'ok':
      return 'kb-status-positive-border kb-status-positive-surface kb-status-positive';
    default:
      return 'kb-status-warning-border kb-status-warning-surface kb-status-warning';
  }
}

function spanTone(status: TraceSpanDetail['status']): string {
  switch (status) {
    case 'error':
      return 'kb-status-negative-border kb-status-negative-surface';
    case 'ok':
      return 'kb-status-positive-border kb-status-positive-surface';
    default:
      return 'kb-status-warning-border kb-status-warning-surface';
  }
}

function gapPhaseBreakdown(span: TraceSpanDetail): Array<{ phase: string; ms: number }> {
  const event = span.events.find((entry) => entry.name === 'gap_phases');
  const raw = event?.attributes?.gap_phases;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { phase: string; ms: number } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as { phase?: unknown }).phase === 'string' &&
        typeof (entry as { ms?: unknown }).ms === 'number'
    );
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
      const parsed = JSON.parse(trimmed) as { traceId?: string };
      if (parsed.traceId === needle) {
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

export function loadTraceViewerPrefs(rawValue?: string | null): TraceViewerPrefs | null {
  const raw =
    rawValue ??
    (typeof window === 'undefined' ? null : window.localStorage.getItem(TRACE_VIEWER_PREFS_KEY));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TraceViewerPrefs>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      filters: {
        ...DEFAULT_FILTERS,
        ...(parsed.filters ?? {}),
      },
      sort:
        parsed.sort === 'error-first' ||
        parsed.sort === 'newest' ||
        parsed.sort === 'oldest' ||
        parsed.sort === 'largest'
          ? parsed.sort
          : DEFAULT_SORT,
      selectedTraceId: typeof parsed.selectedTraceId === 'string' ? parsed.selectedTraceId : null,
      rawTraceFocusTraceId:
        typeof parsed.rawTraceFocusTraceId === 'string' ? parsed.rawTraceFocusTraceId : '',
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

function TraceSpanTree({
  span,
  depth = 0,
  onCopy,
}: {
  span: TraceSpanDetail;
  depth?: number;
  onCopy: (value: string, label: string) => Promise<void> | void;
}) {
  const [showEvents, setShowEvents] = useState(depth === 0);
  const [showArtifacts, setShowArtifacts] = useState(depth === 0);
  const [showChildren, setShowChildren] = useState(depth === 0);
  const [showKnowledge, setShowKnowledge] = useState(depth === 0);
  const previewEvents = span.events.slice(0, 3);
  const previewArtifacts = span.artifacts.slice(0, 3);
  const gapPhases = gapPhaseBreakdown(span);

  return (
    <div
      className={`rounded-2xl border ${spanTone(span.status)} p-3 ${depth > 0 ? 'ml-4 mt-3' : ''}`}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-sm font-semibold kb-text-primary">{span.name}</h5>
            <span className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] kb-text-secondary">
              {span.status}
            </span>
          </div>
          <p className="font-mono text-[11px] kb-text-muted">
            {span.spanId || 'no-span-id'} · {formatTs(span.startTime)}
            {span.endTime ? ` → ${formatTs(span.endTime)}` : ''}
          </p>
          {span.error ? <p className="text-xs kb-status-negative">{span.error}</p> : null}
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px] kb-text-secondary md:text-right">
          <div>
            <div className="kb-text-muted">events</div>
            <div>{span.events.length}</div>
          </div>
          <div>
            <div className="kb-text-muted">artifacts</div>
            <div>{span.artifacts.length}</div>
          </div>
          <div>
            <div className="kb-text-muted">children</div>
            <div>{span.children.length}</div>
          </div>
        </div>
      </div>

      {span.attributes && Object.keys(span.attributes).length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(span.attributes).map(([key, value]) => (
            <span
              key={key}
              className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-0.5 font-mono text-[10px] kb-text-secondary"
            >
              {key}={String(value)}
            </span>
          ))}
        </div>
      ) : null}

      {gapPhases.length > 0 ? (
        <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken p-2">
          <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
            dispatch gap breakdown
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {gapPhases.map((entry) => (
              <div
                key={entry.phase}
                className="flex justify-between gap-3 text-[11px] kb-text-secondary"
              >
                <span>{entry.phase}</span>
                <span className="font-mono">{entry.ms} ms</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {span.knowledgeRefs.length > 0 ? (
          <span className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
            knowledge {span.knowledgeRefs.length}
          </span>
        ) : null}
        {span.events.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowEvents((value) => !value)}
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            {showEvents ? 'Hide' : 'Show'} events {span.events.length}
          </button>
        ) : null}
        {span.events.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              void onCopy(
                span.events
                  .map(
                    (event) =>
                      `${formatTs(event.timestamp)} ${event.name}${event.attributes ? ` ${JSON.stringify(event.attributes)}` : ''}`
                  )
                  .join('\n'),
                'events'
              )
            }
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            Copy events
          </button>
        ) : null}
        {span.artifacts.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowArtifacts((value) => !value)}
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            {showArtifacts ? 'Hide' : 'Show'} artifacts {span.artifacts.length}
          </button>
        ) : null}
        {span.artifacts.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              void onCopy(
                span.artifacts
                  .map(
                    (artifact) =>
                      `${formatTs(artifact.timestamp)} ${artifact.type} ${artifact.description || artifact.path}`
                  )
                  .join('\n'),
                'artifacts'
              )
            }
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            Copy artifacts
          </button>
        ) : null}
        {span.children.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowChildren((value) => !value)}
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            {showChildren ? 'Hide' : 'Show'} children {span.children.length}
          </button>
        ) : null}
        {span.knowledgeRefs.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowKnowledge((value) => !value)}
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            {showKnowledge ? 'Hide' : 'Show'} refs {span.knowledgeRefs.length}
          </button>
        ) : null}
        {span.knowledgeRefs.length > 0 ? (
          <button
            type="button"
            onClick={() => void onCopy(span.knowledgeRefs.join('\n'), 'knowledge refs')}
            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
          >
            Copy refs
          </button>
        ) : null}
      </div>

      {showKnowledge && span.knowledgeRefs.length > 0 ? (
        <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken p-2">
          <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
            knowledge refs
          </div>
          <div className="mt-1 space-y-1">
            {span.knowledgeRefs.slice(0, 4).map((ref) => (
              <div key={ref} className="font-mono text-[10px] kb-text-secondary">
                {ref}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {showEvents && previewEvents.length > 0 ? (
        <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken p-2">
          <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">events</div>
          <div className="mt-1 space-y-1">
            {previewEvents.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="text-[11px] kb-text-secondary">
                <span className="font-mono kb-text-muted">{formatTs(event.timestamp)}</span>{' '}
                {event.name}
              </div>
            ))}
            {span.events.length > previewEvents.length ? (
              <div className="text-[10px] kb-text-muted">
                +{span.events.length - previewEvents.length} more
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showArtifacts && previewArtifacts.length > 0 ? (
        <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken p-2">
          <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">artifacts</div>
          <div className="mt-1 space-y-1">
            {previewArtifacts.map((artifact, index) => (
              <div key={`${artifact.timestamp}-${index}`} className="text-[11px] kb-text-secondary">
                <span className="font-mono kb-text-muted">{artifact.type}</span>{' '}
                {artifact.description || artifact.path}
              </div>
            ))}
            {span.artifacts.length > previewArtifacts.length ? (
              <div className="text-[10px] kb-text-muted">
                +{span.artifacts.length - previewArtifacts.length} more
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showChildren && span.children.length > 0 ? (
        <div className="mt-3 space-y-3">
          {span.children.map((child, index) => (
            <TraceSpanTree
              key={`${child.spanId || child.name}-${index}`}
              span={child}
              depth={depth + 1}
              onCopy={onCopy}
            />
          ))}
        </div>
      ) : null}
    </div>
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
        const payload = (await response.json()) as TraceFeedResponse;
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
        const payload = (await response.json()) as TraceDetailResponse;
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
      setCopiedValue(label);
      window.setTimeout(
        () => setCopiedValue((current) => (current === label ? null : current)),
        1600
      );
    } catch {
      setCopiedValue(`copy failed: ${label}`);
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

  return (
    <section className="rounded-3xl border kb-border-subtle bg-gradient-to-br from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent p-6 kb-text-primary shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
      <div className="flex flex-col gap-4 border-b kb-border-subtle pb-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.35em] kb-text-muted">Trace Viewer</p>
          <h3 className="text-2xl font-semibold">Execution traces</h3>
          <p className="max-w-2xl text-sm leading-6 kb-text-secondary">
            Chronos reads persisted JSONL traces from the shared runtime log and surfaces the latest
            execution summaries, span trees, events, artifact references, and filterable search.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshTick((value) => value + 1)}
          className="inline-flex h-10 items-center justify-center rounded-full border kb-border-subtle kb-surface-raised px-4 text-sm font-medium kb-text-primary transition hover:kb-surface-raised"
        >
          Refresh
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border kb-border-subtle kb-surface-sunken p-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] kb-text-muted">
          <SlidersHorizontal className="h-4 w-4" />
          Filters
        </div>
        <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">1-9 · J/K · R</div>
        <label className="flex min-w-[10rem] flex-1 items-center gap-2 rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-secondary">
          <Search className="h-4 w-4 kb-text-muted" />
          <input
            value={filters.query}
            onChange={(event) =>
              setFilters((current) => ({ ...current, query: event.target.value }))
            }
            placeholder="Search trace ID, mission, actuator, or root span"
            className="w-full bg-transparent text-sm kb-text-primary placeholder:kb-text-muted outline-none"
          />
        </label>
        <select
          value={filters.status}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              status:
                event.target.value === 'all'
                  ? 'all'
                  : (event.target.value as TraceFilters['status']),
            }))
          }
          className="rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-primary outline-none"
        >
          <option value="all">All statuses</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="in_progress">in_progress</option>
        </select>
        <select
          value={filters.missionId}
          onChange={(event) =>
            setFilters((current) => ({ ...current, missionId: event.target.value }))
          }
          className="rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-primary outline-none"
        >
          <option value="">All missions</option>
          {missionOptions.map((missionId) => (
            <option key={missionId} value={missionId}>
              {missionId}
            </option>
          ))}
        </select>
        <select
          value={filters.actuator}
          onChange={(event) =>
            setFilters((current) => ({ ...current, actuator: event.target.value }))
          }
          className="rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-primary outline-none"
        >
          <option value="">All actuators</option>
          {actuatorOptions.map((actuator) => (
            <option key={actuator} value={actuator}>
              {actuator}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as TraceSort)}
          className="rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-primary outline-none"
        >
          <option value="error-first">Errors first</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="largest">Largest spans</option>
        </select>
        <button
          type="button"
          onClick={resetTraceViewerPrefs}
          className="rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-primary transition hover:kb-surface-raised"
        >
          Reset
        </button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-3">
          {loadingList && (
            <SurfaceStatusPanel
              eyebrow="Trace feed"
              title="Loading trace feed"
              detail="Chronos is reading persisted JSONL traces from the shared runtime log."
              tone="neutral"
            />
          )}
          {listError && (
            <SurfaceStatusPanel
              eyebrow="Trace feed"
              title="Unable to load traces"
              detail={listError}
              tone="error"
              actionLabel="Retry"
              onAction={() => setRefreshTick((value) => value + 1)}
            />
          )}
          {!loadingList && !listError && traces.length === 0 && (
            <SurfaceStatusPanel
              eyebrow="No matches"
              title="No traces matched the current filters"
              detail={`Try clearing the filters or refreshing. The trace directory is ${data?.traceDir ?? 'active/shared/logs/traces'}.`}
              tone="warning"
              actionLabel="Reset filters"
              onAction={resetTraceViewerPrefs}
              secondaryActionLabel="Refresh"
              onSecondaryAction={() => setRefreshTick((value) => value + 1)}
            />
          )}

          <div className="space-y-3">
            {visibleTraces.map((trace) => {
              const selected = trace.traceId === selectedTraceId;
              return (
                <button
                  key={`${trace.traceId}:${trace.persistedAt}`}
                  type="button"
                  onClick={() => setSelectedTraceId(trace.traceId)}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    selected
                      ? 'kb-border-accent kb-surface-accent shadow-[0_0_0_1px_rgba(103,232,249,0.12)]'
                      : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-well'
                  }`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs kb-text-muted">{trace.traceId}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.24em] ${statusTone(trace.status)}`}
                        >
                          {trace.status}
                        </span>
                      </div>
                      <h4 className="text-lg font-medium kb-text-primary">{trace.rootSpanName}</h4>
                      <p className="text-sm kb-text-secondary">
                        {trace.missionId ? `mission ${trace.missionId}` : 'mission unknown'}
                        {trace.pipelineId ? ` · pipeline ${trace.pipelineId}` : ''}
                        {trace.actuator ? ` · ${trace.actuator}` : ''}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs kb-text-secondary md:text-right">
                      <div>
                        <div className="kb-text-muted">persisted</div>
                        <div>{formatTs(trace.persistedAt)}</div>
                      </div>
                      <div>
                        <div className="kb-text-muted">completed</div>
                        <div>{formatTs(trace.completedAt)}</div>
                      </div>
                      <div>
                        <div className="kb-text-muted">spans</div>
                        <div>{trace.spanCount}</div>
                      </div>
                      <div>
                        <div className="kb-text-muted">events</div>
                        <div>{trace.eventCount}</div>
                      </div>
                      <div>
                        <div className="kb-text-muted">errors</div>
                        <div className={trace.errorCount > 0 ? 'kb-status-negative' : undefined}>
                          {trace.errorCount}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="space-y-3 rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.3em] kb-text-muted">Selected Trace</p>
            <h4 className="text-lg font-semibold kb-text-primary">
              {selectedSummary?.rootSpanName ?? 'No trace loaded'}
            </h4>
          </div>

          {loadingDetail && (
            <SurfaceStatusPanel
              eyebrow="Selected trace"
              title="Loading trace detail"
              detail="The selected trace is being resolved into its span tree and raw record."
              tone="neutral"
            />
          )}
          {detailError && (
            <SurfaceStatusPanel
              eyebrow="Selected trace"
              title="Unable to load trace detail"
              detail={detailError}
              tone="error"
              actionLabel="Retry"
              onAction={() => setRefreshTick((value) => value + 1)}
            />
          )}

          {selectedTrace ? (
            <div className="space-y-3 text-sm kb-text-secondary">
              <div className="flex flex-wrap gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.22em] ${statusTone(selectedTrace.status)}`}
                >
                  {selectedTrace.status}
                </span>
                {selectedTrace.missionId ? (
                  <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-0.5 text-[11px] uppercase tracking-[0.22em] kb-text-secondary">
                    mission {selectedTrace.missionId}
                  </span>
                ) : null}
                {selectedTrace.pipelineId ? (
                  <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-0.5 text-[11px] uppercase tracking-[0.22em] kb-text-secondary">
                    pipeline {selectedTrace.pipelineId}
                  </span>
                ) : null}
                {selectedTrace.actuator ? (
                  <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-0.5 text-[11px] uppercase tracking-[0.22em] kb-text-secondary">
                    {selectedTrace.actuator}
                  </span>
                ) : null}
                <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-0.5 text-[11px] uppercase tracking-[0.22em] kb-text-secondary">
                  {selectedTrace.errorCount} errors
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyText(selectedTrace.traceId, 'trace id')}
                  className="rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                >
                  Copy trace id
                </button>
                <button
                  type="button"
                  onClick={() => void copyText(selectedTrace.tracePath, 'trace path')}
                  className="rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                >
                  Copy trace path
                </button>
                {copiedValue ? (
                  <span className="text-[11px] uppercase tracking-[0.18em] kb-status-positive">
                    {copiedValue}
                  </span>
                ) : null}
              </div>

              <dl className="space-y-2">
                <div>
                  <dt className="kb-text-muted">Trace ID</dt>
                  <dd className="font-mono text-xs kb-text-secondary">{selectedTrace.traceId}</dd>
                </div>
                <div>
                  <dt className="kb-text-muted">Root span</dt>
                  <dd>{selectedTrace.rootSpan.name}</dd>
                </div>
                <div>
                  <dt className="kb-text-muted">Status</dt>
                  <dd>{selectedTrace.status}</dd>
                </div>
                <div>
                  <dt className="kb-text-muted">Counts</dt>
                  <dd>
                    {selectedTrace.spanCount} spans, {selectedTrace.eventCount} events,{' '}
                    {selectedTrace.artifactCount} artifacts
                    {selectedTrace.errorCount > 0 ? `, ${selectedTrace.errorCount} errors` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="kb-text-muted">Started</dt>
                  <dd>{formatTs(selectedTrace.startedAt)}</dd>
                </div>
                <div>
                  <dt className="kb-text-muted">Persisted</dt>
                  <dd>{formatTs(selectedTrace.persistedAt)}</dd>
                </div>
              </dl>

              <button
                type="button"
                onClick={() =>
                  void openRawTraceFile(selectedTrace.tracePath, selectedTrace.traceId)
                }
                className="w-full rounded-2xl border border-dashed kb-border-subtle kb-surface-raised/5 p-3 text-left font-mono text-[11px] kb-text-secondary transition hover:kb-border-accent hover:kb-surface-accent"
              >
                {selectedTrace.tracePath}
              </button>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void openRawTraceFile(selectedTrace.tracePath, selectedTrace.traceId)
                  }
                  className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                >
                  Open raw trace
                </button>
                <button
                  type="button"
                  disabled={!rawTraceText}
                  onClick={() => void copyText(rawTraceText || '', 'focused raw record')}
                  className="rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Copy focused record
                </button>
                <button
                  type="button"
                  onClick={() => setRawTraceVisible((value) => !value)}
                  className="rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                >
                  {rawTraceVisible ? 'Hide' : 'Show'} raw trace
                </button>
              </div>

              {rawTraceVisible ? (
                <div className="rounded-2xl border kb-border-subtle kb-surface-well p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs uppercase tracking-[0.24em] kb-text-muted">
                      Raw trace log
                    </div>
                    <div className="text-[11px] kb-text-muted">{selectedTrace.tracePath}</div>
                  </div>
                  {rawTraceFocusHistory.length > 1 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                        recent
                      </div>
                      {rawTraceFocusHistory.map((traceId) => (
                        <button
                          key={traceId}
                          type="button"
                          onClick={() => {
                            setRawTraceFocusTraceId(traceId);
                            void refocusRawTraceFile(traceId);
                          }}
                          className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition ${
                            traceId === rawTraceFocusTraceId
                              ? 'kb-border-accent kb-surface-accent kb-text-accent'
                              : 'kb-border-subtle kb-surface-sunken kb-text-secondary hover:kb-surface-raised'
                          }`}
                        >
                          {traceId}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-xl border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-sm kb-text-secondary">
                      <span className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                        trace id
                      </span>
                      <input
                        value={rawTraceFocusTraceId}
                        onChange={(event) => setRawTraceFocusTraceId(event.target.value)}
                        placeholder={selectedTrace.traceId}
                        className="w-full bg-transparent text-sm kb-text-primary placeholder:kb-text-muted outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void refocusRawTraceFile()}
                      className="rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                    >
                      Re-focus
                    </button>
                  </div>
                  {rawTraceLoading ? (
                    <div className="mt-2">
                      <SurfaceStatusPanel
                        eyebrow="Raw trace"
                        title="Loading raw trace log"
                        detail="Chronos is opening the selected JSONL record and focusing it on the chosen trace id."
                        tone="neutral"
                      />
                    </div>
                  ) : rawTraceError ? (
                    <div className="mt-2">
                      <SurfaceStatusPanel
                        eyebrow="Raw trace"
                        title="Unable to load raw trace log"
                        detail={rawTraceError}
                        tone="error"
                      />
                    </div>
                  ) : rawTraceText ? (
                    <pre className="mt-2 max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border kb-border-accent kb-surface-well p-3 font-mono text-[11px] leading-5 kb-text-secondary">
                      {rawTraceText}
                    </pre>
                  ) : (
                    <div className="mt-2">
                      <SurfaceStatusPanel
                        eyebrow="Raw trace"
                        title="Open the raw file to inspect the JSONL trace"
                        detail="The span tree is already available above; open the raw file only when you need the source record."
                        tone="info"
                      />
                    </div>
                  )}
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="text-xs uppercase tracking-[0.24em] kb-text-muted">Span tree</div>
                <TraceSpanTree span={selectedTrace.rootSpan} onCopy={copyText} />
              </div>
            </div>
          ) : (
            <SurfaceStatusPanel
              eyebrow="Selected trace"
              title="No trace selected"
              detail="Choose a trace from the list to inspect its span tree, metadata, and raw JSONL record."
              tone="info"
              actionLabel="Reset filters"
              onAction={resetTraceViewerPrefs}
            />
          )}
        </aside>
      </div>
    </section>
  );
}
