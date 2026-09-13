'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText } from '../lib/i18n';
import {
  parseConciergeSummaryEvent,
  parseConciergeSummaryResponse,
  type ConciergeSummary,
} from '../lib/summary-event';
import {
  parseConciergeHygieneResponse,
  parseConciergeMemoryQueueResponse,
  parseConciergeResponseStatusResponse,
  type ConciergeHygieneInquiry,
  type ConciergeMemoryQueueItem,
  type ConciergeResponseStatus,
} from '../lib/concierge-advisory-response';
import {
  parseConciergeOutcomePreviewResponse,
  type ConciergeOutcomePreview,
} from '../lib/outcome-preview-response';
import { parseConciergeMutationResponse } from '../lib/mutation-response';
import {
  deriveCardFields,
  groupDecideQueue,
  hasEffectColumn,
  presentKinds,
  type DecideKind,
  type DecideQueueEntry,
} from '../lib/decide-view';

type HygieneInquiry = ConciergeHygieneInquiry;
type MemoryQueueItem = ConciergeMemoryQueueItem;
type ResponseStatus = ConciergeResponseStatus;

type OutcomePreview = ConciergeOutcomePreview;

// FD-04: the viewer identity used only to render "決める人" (decide_by) on
// every card — the same identity every card shares, since a browser session
// is always a single human. Read-only: this page never switches tenant, it
// only follows whichever tenant the shared rail (front-desk-rail.tsx) last
// stored, so the two stay consistent without duplicating the switcher UI.
const TENANT_STORAGE_KEY = 'front-desk.tenant';
const DEFERRED_STORAGE_KEY = 'front-desk.deferred';

type DecideRole = 'owner' | 'approver' | 'viewer';

interface DecideViewerInfo {
  name: string;
  role: DecideRole;
}

interface DecideRoleLabels {
  owner: string;
  approver: string;
  viewer: string;
}

function formatWhen(value: string | undefined, locale: 'en' | 'ja'): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

// Mirrors `@agent/core/format`'s `formatRelativeTime` thresholds, but
// implemented locally with the browser's own `Intl.RelativeTimeFormat`: the
// shared module pulls in `secure-io`/`personal-identity-state` (node:fs,
// node:crypto, …) at the top of the same file, which cannot be bundled for
// the client (`next build` fails on "node:*" scheme imports) — this page is
// `'use client'`, so it stays with the browser-only primitive instead.
const RELATIVE_TIME_THRESHOLDS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

function relativeWhen(value: string | undefined, locale: 'en' | 'ja'): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const formatter = new Intl.RelativeTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    numeric: 'auto',
  });
  for (const { unit, ms } of RELATIVE_TIME_THRESHOLDS) {
    if (absMs >= ms) return formatter.format(Math.round(diffMs / ms), unit);
  }
  return formatter.format(Math.round(diffMs / 1000), 'second');
}

function readStoredTenant(): string | null {
  try {
    return window.localStorage.getItem(TENANT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredDeferredIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DEFERRED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function storeDeferredIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DEFERRED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // best-effort only — a value that cannot persist still redraws once.
  }
}

/**
 * FD-04 shared card frame: top line (kind tag / relative time / decide_by),
 * title, and the why/effect columns (stacked below 720px via CSS). Every
 * `render*Card` below builds its own action row and passes it as children so
 * the guarded decision endpoints stay exactly where they were (CS-03/CS-04).
 */
function DecideCardFrame({
  reactKey,
  kind,
  kindLabel,
  timeIso,
  timeAbsolute,
  decideByText,
  extraMeta,
  title,
  fields,
  locale,
  children,
}: {
  reactKey: string;
  kind: DecideKind;
  kindLabel: string;
  timeIso: string | undefined;
  timeAbsolute: string;
  decideByText: string | null;
  /** Extra top-line meta after the relative time (e.g. an approval deadline). */
  extraMeta?: React.ReactNode;
  title: React.ReactNode;
  fields: ReturnType<typeof deriveCardFields>;
  locale: 'en' | 'ja';
  children: React.ReactNode;
}) {
  const relative = relativeWhen(timeIso, locale);
  const showColumns = Boolean(fields.why) || hasEffectColumn(fields);
  return (
    <div key={reactKey} className="item-card decide-card">
      <div className="decide-card-top">
        <span className={`queue-chip ${kind}`}>{kindLabel}</span>
        {relative ? (
          <span className="decide-time" title={timeAbsolute || undefined}>
            {relative}
          </span>
        ) : null}
        {extraMeta ? <span className="decide-time decide-due">{extraMeta}</span> : null}
        {decideByText ? <span className="decide-by-badge">{decideByText}</span> : null}
      </div>
      <p className="item-title decide-card-title">{title}</p>
      {showColumns ? (
        <div className="decide-columns">
          {fields.why ? (
            <div className="decide-column">
              <p className="decide-column-label">{frontDeskText('decide_why', locale)}</p>
              <p className="item-body">{fields.why}</p>
            </div>
          ) : null}
          {hasEffectColumn(fields) && fields.effectLabelKey ? (
            <div className="decide-column">
              <p className="decide-column-label">{frontDeskText(fields.effectLabelKey, locale)}</p>
              <p className="item-body">{fields.effect}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
      {fields.evidenceHref ? (
        <a className="decide-evidence-link" href={fields.evidenceHref}>
          {frontDeskText('decide_evidence', locale)}
        </a>
      ) : null}
    </div>
  );
}

export default function ConciergePage() {
  const { locale, t } = useConciergeI18n();
  const [summary, setSummary] = React.useState<ConciergeSummary | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [responseStatus, setResponseStatus] = React.useState<ResponseStatus | null>(null);

  // FD-04: "決める人" — who is deciding, read once from the same identity
  // contract the rail uses (plan §2.4 `GET /api/me` + `/api/front-desk/nav`
  // role_labels). Advisory only: a failed fetch just omits the badge.
  const [viewer, setViewer] = React.useState<DecideViewerInfo | null>(null);
  const [roleLabels, setRoleLabels] = React.useState<DecideRoleLabels | null>(null);

  React.useEffect(() => {
    const tenant = readStoredTenant();
    const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    fetch(`/api/me${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          (data as { ok?: unknown }).ok === true &&
          typeof (data as { member?: { display_name?: unknown } }).member?.display_name ===
            'string' &&
          typeof (data as { viewing?: { role?: unknown } }).viewing?.role === 'string'
        ) {
          const parsed = data as {
            member: { display_name: string; member_id?: string };
            viewing: { role: DecideRole };
          };
          // A synthetic principal label (no member registry yet, FD-07) is
          // not a person's name — render "あなた" instead of `human:…`.
          const synthetic =
            parsed.member.display_name === parsed.member.member_id ||
            /^(human|user|agent):/.test(parsed.member.display_name);
          setViewer({
            name: synthetic ? '' : parsed.member.display_name,
            role: parsed.viewing.role,
          });
        }
      })
      .catch(() => {
        // decide_by is advisory — its absence never blocks the queue.
      });
  }, []);

  React.useEffect(() => {
    fetch(`/api/front-desk/nav?locale=${locale}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const labels = (data as { role_labels?: DecideRoleLabels } | null)?.role_labels;
        if (labels) setRoleLabels(labels);
      })
      .catch(() => {
        // decide_by is advisory — its absence never blocks the queue.
      });
  }, [locale]);

  const decideByText =
    viewer && roleLabels
      ? frontDeskText('decide_by', locale, {
          name: viewer.name || frontDeskText('you', locale),
          role: roleLabels[viewer.role],
        })
      : null;

  // FD-04: "あとで見る" (decide_later) is client-side only — it moves a card
  // into the collapsed section below and never calls a server endpoint.
  // Persisted per browser in localStorage so a reload does not surface an
  // item the human already set aside (but never hides it permanently either).
  const [deferredIds, setDeferredIds] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    setDeferredIds(readStoredDeferredIds());
  }, []);
  const deferItem = React.useCallback((id: string) => {
    setDeferredIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      storeDeferredIds(next);
      return next;
    });
  }, []);
  const undeferItem = React.useCallback((id: string) => {
    setDeferredIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      storeDeferredIds(next);
      return next;
    });
  }, []);

  const [kindFilter, setKindFilter] = React.useState<DecideKind | 'all'>('all');

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch('/api/summary', { cache: 'no-store' });
      const nextSummary = parseConciergeSummaryResponse(await response.json().catch(() => null));
      if (!response.ok || !nextSummary) throw new Error('Invalid summary response');
      setSummary(nextSummary);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshResponseStatus = React.useCallback(async () => {
    try {
      const response = await fetch('/api/response-status', { cache: 'no-store' });
      const parsed = parseConciergeResponseStatusResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid response status response');
      setResponseStatus(parsed);
    } catch {
      // The response-status panel is advisory; the main concierge remains usable.
    }
  }, []);

  // CS-03: 停滞ミッション伺いカード — stalled requests waiting for a human
  // start/withdraw decision. The pane only appears when there is something to
  // decide, and nothing is ever decided without an explicit confirmed click.
  const [hygiene, setHygiene] = React.useState<HygieneInquiry[]>([]);
  const [hygieneBusyId, setHygieneBusyId] = React.useState<string | null>(null);
  const [hygieneConfirm, setHygieneConfirm] = React.useState<{
    missionId: string;
    decision: 'start' | 'cancel';
  } | null>(null);
  const [hygieneNote, setHygieneNote] = React.useState('');

  const refreshHygiene = React.useCallback(async () => {
    try {
      const response = await fetch('/api/hygiene', { cache: 'no-store' });
      const parsed = parseConciergeHygieneResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid hygiene response');
      setHygiene(parsed);
    } catch {
      // Advisory pane: a failed hygiene fetch never blocks the concierge.
    }
  }, []);

  // CS-03 記憶昇格キュー — proposed learnings awaiting the human's blessing.
  // The pane only appears when candidates exist, and nothing is approved or
  // rejected without an explicit confirmed click (§0: human gates stay human).
  const [memoryQueue, setMemoryQueue] = React.useState<MemoryQueueItem[]>([]);
  const [memoryBusyId, setMemoryBusyId] = React.useState<string | null>(null);
  const [memoryConfirm, setMemoryConfirm] = React.useState<{
    id: string;
    decision: 'approve' | 'reject';
  } | null>(null);

  const refreshMemoryQueue = React.useCallback(async () => {
    try {
      const response = await fetch('/api/memory-queue', { cache: 'no-store' });
      const parsed = parseConciergeMemoryQueueResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid memory queue response');
      setMemoryQueue(parsed);
    } catch {
      // Advisory pane: a failed queue fetch never blocks the concierge.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    void refreshResponseStatus();
    void refreshHygiene();
    void refreshMemoryQueue();
    // CS-01: live summary updates over SSE; degrade to the legacy 30 s
    // polling only when the event stream is unavailable.
    let source: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const startPollingFallback = () => {
      if (!fallbackTimer) fallbackTimer = setInterval(() => void refresh(), 30_000);
    };
    try {
      source = new EventSource('/api/events');
      source.addEventListener('summary', (event) => {
        try {
          const nextSummary = parseConciergeSummaryEvent((event as MessageEvent).data);
          if (!nextSummary) return;
          setSummary(nextSummary);
          setLoadError(null);
        } catch {
          // Keep the last good snapshot when one event fails to parse.
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        startPollingFallback();
      };
    } catch {
      startPollingFallback();
    }
    const responseTimer = setInterval(() => void refreshResponseStatus(), 10_000);
    // The hygiene report scans mission directories; a relaxed cadence is
    // plenty for a list that changes on the order of days. The memory queue
    // moves at the same human pace.
    const hygieneTimer = setInterval(() => void refreshHygiene(), 60_000);
    const memoryTimer = setInterval(() => void refreshMemoryQueue(), 60_000);
    return () => {
      source?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      clearInterval(responseTimer);
      clearInterval(hygieneTimer);
      clearInterval(memoryTimer);
    };
  }, [refresh, refreshResponseStatus, refreshHygiene, refreshMemoryQueue]);

  const decideApproval = React.useCallback(
    async (item: ConciergeSummary['approval_queue'][number], decision: 'approved' | 'rejected') => {
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(item.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            channel: item.channel,
            storageChannel: item.storage_channel,
          }),
        });
        if (!response.ok) throw new Error('Approval failed');
        setNotice({
          text: t(decision === 'approved' ? 'home.approved_notice' : 'home.rejected_notice', {
            title: item.title,
          }),
        });
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  const [changeFormId, setChangeFormId] = React.useState<string | null>(null);
  const [changeNote, setChangeNote] = React.useState('');

  const recordOutcomeVerdict = React.useCallback(
    async (
      item: ConciergeSummary['outcome_feed'][number],
      status: 'accepted' | 'changes_requested' | 'rejected',
      note = ''
    ) => {
      // CS-01: change requests arrive through the inline form below (the
      // blocking browser prompt is gone); an empty note never reaches the owner.
      if (status === 'changes_requested' && !note.trim()) return;
      setBusyId(item.entry_id);
      try {
        const response = await fetch(`/api/outcomes/${encodeURIComponent(item.entry_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, note }),
        });
        if (!response.ok) throw new Error('Verdict failed');
        setNotice({
          text: t(
            status === 'accepted'
              ? 'home.accepted_notice'
              : status === 'rejected'
                ? 'home.rejected_notice'
                : 'home.changes_notice',
            { title: item.title }
          ),
        });
        setChangeFormId(null);
        setChangeNote('');
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  // CS-03: the decision only fires from the inline confirm step — there is no
  // auto-start, no auto-cancel, and no blocking browser dialog.
  const decideHygiene = React.useCallback(
    async (item: HygieneInquiry, decision: 'start' | 'cancel', note: string) => {
      setHygieneBusyId(item.mission_id);
      try {
        const response = await fetch(`/api/hygiene/${encodeURIComponent(item.mission_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, ...(note.trim() ? { note: note.trim() } : {}) }),
        });
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed?.result?.message) throw new Error('Hygiene action failed');
        setNotice({ text: parsed.result.message });
        setHygieneConfirm(null);
        setHygieneNote('');
        await refreshHygiene();
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setHygieneBusyId(null);
      }
    },
    [refresh, refreshHygiene]
  );

  // CS-03: a memory decision only fires from the inline confirm step — no
  // auto-approval, no default, no blocking browser dialog.
  const decideMemory = React.useCallback(
    async (item: MemoryQueueItem, decision: 'approve' | 'reject') => {
      setMemoryBusyId(item.id);
      try {
        const response = await fetch(`/api/memory-queue/${encodeURIComponent(item.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed?.result?.message) throw new Error('Memory decision failed');
        setNotice({ text: parsed.result.message });
        setMemoryConfirm(null);
        await refreshMemoryQueue();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setMemoryBusyId(null);
      }
    },
    [refreshMemoryQueue]
  );

  // CS-03 受領プレビュー: one preview open at a time, fetched on demand.
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewData, setPreviewData] = React.useState<OutcomePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewBusyId, setPreviewBusyId] = React.useState<string | null>(null);

  const togglePreview = React.useCallback(
    async (item: ConciergeSummary['outcome_feed'][number]) => {
      if (previewId === item.entry_id) {
        setPreviewId(null);
        setPreviewData(null);
        setPreviewError(null);
        return;
      }
      setPreviewBusyId(item.entry_id);
      try {
        const response = await fetch(`/api/outcomes/${encodeURIComponent(item.entry_id)}/preview`, {
          cache: 'no-store',
        });
        const parsed = parseConciergeOutcomePreviewResponse(
          await response.json().catch(() => null)
        );
        if (!response.ok || !parsed) throw new Error('Invalid outcome preview response');
        setPreviewData(parsed);
        setPreviewError(null);
      } catch (error) {
        setPreviewData(null);
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewId(item.entry_id);
        setPreviewBusyId(null);
      }
    },
    [previewId]
  );

  if (loadError) {
    return <div className="notice error">{t('home.load_error', { error: loadError })}</div>;
  }
  if (!summary) {
    return <div className="pane-empty">{t('home.loading')}</div>;
  }

  // CS-04/FD-04 — every item awaiting the human's decision is rendered by one
  // card helper per kind; the unified queue is the only place these render
  // (the four duplicate panes are gone, plan §2.1/FD-04).
  const renderApprovalCard = (entry: Extract<DecideQueueEntry, { kind: 'approval' }>) => {
    const item = entry.item;
    const fields = deriveCardFields(entry);
    return (
      <DecideCardFrame
        key={entry.id}
        reactKey={entry.id}
        kind="approval"
        kindLabel={t('queue.type.approval')}
        timeIso={item.requested_at}
        timeAbsolute={formatWhen(item.requested_at, locale)}
        decideByText={decideByText}
        extraMeta={
          item.expires_at
            ? frontDeskText('decide_due', locale, {
                value: relativeWhen(item.expires_at, locale) || formatWhen(item.expires_at, locale),
              })
            : null
        }
        title={item.title}
        fields={fields}
        locale={locale}
      >
        <div className="button-row">
          <button
            type="button"
            className="action-button"
            disabled={busyId === item.id}
            onClick={() => void decideApproval(item, 'approved')}
          >
            {frontDeskText('decide_approve', locale)}
          </button>
          <button
            type="button"
            className="action-button danger"
            disabled={busyId === item.id}
            onClick={() => void decideApproval(item, 'rejected')}
          >
            {frontDeskText('decide_reject', locale)}
          </button>
          <button
            type="button"
            className="action-button secondary"
            disabled={busyId === item.id}
            onClick={() => deferItem(entry.id)}
          >
            {frontDeskText('decide_later', locale)}
          </button>
        </div>
      </DecideCardFrame>
    );
  };

  const renderHygieneCard = (entry: Extract<DecideQueueEntry, { kind: 'hygiene' }>) => {
    const item = entry.item;
    const fields = deriveCardFields(entry);
    // `fields.why` is the raw reason code (see decide-view.ts) — translated
    // here via the existing `hygiene.reason.<code>` key, matching the
    // pre-FD-04 card.
    const translatedFields = {
      ...fields,
      why: fields.why ? t(`hygiene.reason.${fields.why}` as Parameters<typeof t>[0]) : undefined,
    };
    return (
      <DecideCardFrame
        key={entry.id}
        reactKey={entry.id}
        kind="hygiene"
        kindLabel={t('queue.type.hygiene')}
        timeIso={item.waiting_since}
        timeAbsolute={formatWhen(item.waiting_since, locale)}
        decideByText={decideByText}
        title={item.title}
        fields={translatedFields}
        locale={locale}
      >
        {hygieneConfirm?.missionId === item.mission_id ? (
          <div className="hygiene-confirm">
            <p className="item-body">
              {t(
                hygieneConfirm.decision === 'start'
                  ? 'hygiene.confirm_start'
                  : 'hygiene.confirm_cancel'
              )}
            </p>
            {hygieneConfirm.decision === 'cancel' ? (
              <label className="field-label">
                {t('hygiene.note_label')}
                <textarea
                  value={hygieneNote}
                  rows={2}
                  onChange={(event) => setHygieneNote(event.target.value)}
                />
              </label>
            ) : null}
            <div className="button-row">
              <button
                type="button"
                className="action-button"
                disabled={hygieneBusyId === item.mission_id}
                onClick={() => void decideHygiene(item, hygieneConfirm.decision, hygieneNote)}
              >
                {t('hygiene.confirm_yes')}
              </button>
              <button
                type="button"
                className="action-button secondary"
                disabled={hygieneBusyId === item.mission_id}
                onClick={() => {
                  setHygieneConfirm(null);
                  setHygieneNote('');
                }}
              >
                {t('hygiene.confirm_back')}
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button
              type="button"
              className="action-button"
              disabled={hygieneBusyId !== null}
              onClick={() => {
                setHygieneConfirm({ missionId: item.mission_id, decision: 'start' });
                setHygieneNote('');
              }}
            >
              {frontDeskText('decide_continue', locale)}
            </button>
            <button
              type="button"
              className="action-button danger"
              disabled={hygieneBusyId !== null}
              onClick={() => {
                setHygieneConfirm({ missionId: item.mission_id, decision: 'cancel' });
                setHygieneNote('');
              }}
            >
              {frontDeskText('decide_stop', locale)}
            </button>
            <button
              type="button"
              className="action-button secondary"
              disabled={hygieneBusyId !== null}
              onClick={() => deferItem(entry.id)}
            >
              {frontDeskText('decide_later', locale)}
            </button>
          </div>
        )}
      </DecideCardFrame>
    );
  };

  const renderMemoryCard = (entry: Extract<DecideQueueEntry, { kind: 'memory' }>) => {
    const item = entry.item;
    const fields = deriveCardFields(entry);
    return (
      <DecideCardFrame
        key={entry.id}
        reactKey={entry.id}
        kind="memory"
        kindLabel={t('queue.type.memory')}
        timeIso={item.queued_at}
        timeAbsolute={formatWhen(item.queued_at, locale)}
        decideByText={decideByText}
        title={
          <>
            {t(`memory.kind.${item.kind}` as Parameters<typeof t>[0])}
            <span className="status-chip">
              {t(`memory.tier.${item.sensitivity_tier}` as Parameters<typeof t>[0])}
            </span>
          </>
        }
        fields={fields}
        locale={locale}
      >
        {memoryConfirm?.id === item.id ? (
          <div className="memory-confirm">
            <p className="item-body">
              {t(
                memoryConfirm.decision === 'approve'
                  ? 'memory.confirm_approve'
                  : 'memory.confirm_reject'
              )}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="action-button"
                disabled={memoryBusyId === item.id}
                onClick={() => void decideMemory(item, memoryConfirm.decision)}
              >
                {t('memory.confirm_yes')}
              </button>
              <button
                type="button"
                className="action-button secondary"
                disabled={memoryBusyId === item.id}
                onClick={() => setMemoryConfirm(null)}
              >
                {t('memory.confirm_back')}
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button
              type="button"
              className="action-button"
              disabled={memoryBusyId !== null}
              onClick={() => setMemoryConfirm({ id: item.id, decision: 'approve' })}
            >
              {frontDeskText('decide_remember', locale)}
            </button>
            <button
              type="button"
              className="action-button danger"
              disabled={memoryBusyId !== null}
              onClick={() => setMemoryConfirm({ id: item.id, decision: 'reject' })}
            >
              {frontDeskText('decide_forget', locale)}
            </button>
            <button
              type="button"
              className="action-button secondary"
              disabled={memoryBusyId !== null}
              onClick={() => deferItem(entry.id)}
            >
              {frontDeskText('decide_later', locale)}
            </button>
          </div>
        )}
      </DecideCardFrame>
    );
  };

  const renderExceptionCard = (entry: Extract<DecideQueueEntry, { kind: 'exception' }>) => {
    const item = entry.item;
    const fields = deriveCardFields(entry);
    return (
      <DecideCardFrame
        key={entry.id}
        reactKey={entry.id}
        kind="exception"
        kindLabel={t('queue.type.exception')}
        timeIso={item.created_at}
        timeAbsolute={formatWhen(item.created_at, locale)}
        decideByText={decideByText}
        title={item.title}
        fields={fields}
        locale={locale}
      >
        <div className="button-row">
          <button
            type="button"
            className="action-button secondary"
            onClick={() => deferItem(entry.id)}
          >
            {frontDeskText('decide_later', locale)}
          </button>
        </div>
      </DecideCardFrame>
    );
  };

  const renderOutcomeCard = (entry: Extract<DecideQueueEntry, { kind: 'outcome' }>) => {
    const item = entry.item;
    const fields = deriveCardFields(entry);
    return (
      <DecideCardFrame
        key={entry.id}
        reactKey={entry.id}
        kind="outcome"
        kindLabel={t('queue.type.outcome')}
        timeIso={item.updated_at}
        timeAbsolute={formatWhen(item.updated_at, locale)}
        decideByText={decideByText}
        title={
          <>
            {item.title}
            <span className="status-chip">
              {t(`home.status.${item.status}` as Parameters<typeof t>[0]) || item.status}
            </span>
          </>
        }
        fields={fields}
        locale={locale}
      >
        <div className="button-row">
          {item.artifact_paths.length > 0 ? (
            <button
              type="button"
              className="action-button secondary"
              disabled={previewBusyId === item.entry_id}
              onClick={() => void togglePreview(item)}
            >
              {previewId === item.entry_id
                ? t('home.preview_hide')
                : frontDeskText('action_open', locale)}
            </button>
          ) : null}
          <button
            type="button"
            className="action-button"
            disabled={busyId === item.entry_id || item.status === 'accepted'}
            onClick={() => void recordOutcomeVerdict(item, 'accepted')}
          >
            {frontDeskText('decide_receive', locale)}
          </button>
          <button
            type="button"
            className="action-button secondary"
            disabled={busyId === item.entry_id}
            onClick={() => {
              setChangeFormId(changeFormId === item.entry_id ? null : item.entry_id);
              setChangeNote('');
            }}
          >
            {frontDeskText('decide_return', locale)}
          </button>
          <button
            type="button"
            className="action-button secondary"
            disabled={busyId === item.entry_id}
            onClick={() => deferItem(entry.id)}
          >
            {frontDeskText('decide_later', locale)}
          </button>
        </div>
        {previewId === item.entry_id ? (
          <div className="outcome-preview">
            {previewError ? (
              <p className="item-body">{t('home.preview_error', { error: previewError })}</p>
            ) : null}
            {previewData && previewData.files.length === 0 ? (
              <p className="item-meta">{t('home.preview_empty')}</p>
            ) : null}
            {previewData?.files.map((file, index) => (
              <div className="preview-file" key={`${file.name}-${index}`}>
                <p className="preview-name">{file.name}</p>
                {file.kind === 'image' && file.data_uri ? (
                  <img className="preview-image" src={file.data_uri} alt={file.name} />
                ) : (file.kind === 'markdown' || file.kind === 'text') &&
                  typeof file.content === 'string' ? (
                  <pre className="preview-content">{file.content}</pre>
                ) : (
                  <p className="item-meta">
                    {t(
                      file.missing
                        ? 'home.preview_missing'
                        : file.too_large
                          ? 'home.preview_too_large'
                          : 'home.preview_unsupported'
                    )}
                  </p>
                )}
                {file.truncated ? <p className="item-meta">{t('home.preview_truncated')}</p> : null}
              </div>
            ))}
            {previewData && previewData.total > previewData.shown ? (
              <p className="item-meta">
                {t('home.preview_more', { count: previewData.total - previewData.shown })}
              </p>
            ) : null}
          </div>
        ) : null}
        {changeFormId === item.entry_id ? (
          <form
            className="change-request-form"
            onSubmit={(event) => {
              event.preventDefault();
              void recordOutcomeVerdict(item, 'changes_requested', changeNote);
            }}
          >
            <label className="field-label">
              {t('home.change_prompt')}
              <textarea
                value={changeNote}
                rows={3}
                required
                onChange={(event) => setChangeNote(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                type="submit"
                className="action-button"
                disabled={busyId === item.entry_id || !changeNote.trim()}
              >
                {t('home.change_send')}
              </button>
              <button
                type="button"
                className="action-button secondary"
                onClick={() => {
                  setChangeFormId(null);
                  setChangeNote('');
                }}
              >
                {t('home.change_cancel')}
              </button>
            </div>
          </form>
        ) : null}
      </DecideCardFrame>
    );
  };

  // Queue order = decision urgency: approvals block others' work, stalled
  // missions and learnings wait on the human alone, deliverables and
  // exceptions can breathe a little longer.
  const allEntries: DecideQueueEntry[] = [
    ...summary.approval_queue.map((item): DecideQueueEntry => ({
      id: `approval-${item.id}`,
      kind: 'approval',
      item,
    })),
    ...hygiene.map((item): DecideQueueEntry => ({
      id: `hygiene-${item.mission_id}`,
      kind: 'hygiene',
      item,
    })),
    ...memoryQueue.map((item): DecideQueueEntry => ({
      id: `memory-${item.id}`,
      kind: 'memory',
      item,
    })),
    ...summary.outcome_feed.map((item): DecideQueueEntry => ({
      id: `outcome-${item.entry_id}`,
      kind: 'outcome',
      item,
    })),
    ...summary.exception_feed.map((item): DecideQueueEntry => ({
      id: `exception-${item.id}`,
      kind: 'exception',
      item,
    })),
  ];

  const { queue, deferred, countsByKind } = groupDecideQueue(allEntries, deferredIds);
  const visibleKinds = presentKinds(countsByKind);
  const filteredQueue =
    kindFilter === 'all' ? queue : queue.filter((entry) => entry.kind === kindFilter);
  const totalQueueCount = queue.length;

  const renderEntry = (entry: DecideQueueEntry): React.ReactNode => {
    switch (entry.kind) {
      case 'approval':
        return renderApprovalCard(entry);
      case 'hygiene':
        return renderHygieneCard(entry);
      case 'memory':
        return renderMemoryCard(entry);
      case 'outcome':
        return renderOutcomeCard(entry);
      case 'exception':
        return renderExceptionCard(entry);
      default:
        return null;
    }
  };

  return (
    <>
      {notice ? <div className={`notice${notice.error ? ' error' : ''}`}>{notice.text}</div> : null}

      <section
        className="pane inquiry-queue decide-page"
        aria-label={frontDeskText('nav_decide', locale)}
      >
        <h1 className="decide-heading">{frontDeskText('nav_decide', locale)}</h1>
        <p className="pane-subtitle decide-lead">{frontDeskText('decide_lead', locale)}</p>

        <div
          className="decide-filter-row"
          role="group"
          aria-label={frontDeskText('nav_decide', locale)}
        >
          <button
            type="button"
            className={`decide-filter-chip${kindFilter === 'all' ? ' active' : ''}`}
            onClick={() => setKindFilter('all')}
          >
            {frontDeskText('decide_filter_all', locale)} ·{' '}
            {frontDeskText('count_items', locale, { count: totalQueueCount })}
          </button>
          {visibleKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`decide-filter-chip${kindFilter === kind ? ' active' : ''}`}
              onClick={() => setKindFilter(kind)}
            >
              {t(`queue.type.${kind}` as Parameters<typeof t>[0])} ·{' '}
              {frontDeskText('count_items', locale, { count: countsByKind[kind] })}
            </button>
          ))}
        </div>

        {filteredQueue.length === 0 ? (
          <div className="pane-empty">{frontDeskText('decide_empty', locale)}</div>
        ) : (
          filteredQueue.map((entry) => (
            <div key={entry.id} className="queue-item">
              {renderEntry(entry)}
            </div>
          ))
        )}

        {deferred.length > 0 ? (
          <details className="decide-deferred-section">
            <summary>
              {frontDeskText('decide_deferred', locale, { count: deferred.length })}
            </summary>
            {deferred.map((entry) => {
              const title =
                entry.kind === 'approval' || entry.kind === 'hygiene' || entry.kind === 'exception'
                  ? entry.item.title
                  : entry.kind === 'outcome'
                    ? entry.item.title
                    : t(`memory.kind.${entry.item.kind}` as Parameters<typeof t>[0]);
              return (
                <div key={entry.id} className="decide-deferred-item">
                  <span className={`queue-chip ${entry.kind}`}>
                    {t(`queue.type.${entry.kind}` as Parameters<typeof t>[0])}
                  </span>
                  <span className="decide-deferred-title">{title}</span>
                  <button
                    type="button"
                    className="action-button secondary"
                    onClick={() => undeferItem(entry.id)}
                  >
                    {frontDeskText('decide_undefer', locale)}
                  </button>
                </div>
              );
            })}
          </details>
        ) : null}
      </section>

      {responseStatus ? (
        <section className="pane response-status" aria-label={t('home.response_title')}>
          <h2>{t('home.response_title')}</h2>
          <p className="pane-subtitle">{t('home.response_description')}</p>
          <p className={`status-chip${responseStatus.state === 'ready' ? '' : ' attention'}`}>
            {responseStatus.label}
          </p>
          <p className="item-body">{responseStatus.next_action}</p>
          {responseStatus.stale_child_count > 0 ? (
            <p className="item-meta">
              {t('home.response_stale', { count: responseStatus.stale_child_count })}
            </p>
          ) : null}
          {responseStatus.active_tasks.map((task) => (
            <div className="item-meta" key={task.delegation_id}>
              {t('home.response_task', { value: task.task_id || task.delegation_id })}
              {task.backend_name
                ? ` · ${t('home.response_backend', { value: task.backend_name })}`
                : ''}
              {` · ${t('home.response_elapsed', { value: task.elapsed_seconds })}`}
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
