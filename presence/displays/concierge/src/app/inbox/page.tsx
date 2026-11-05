'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  NextAction,
  PageHeader,
  Skeleton,
  Tabs,
} from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { conciergeText, frontDeskText } from '../../lib/i18n';
import { renderDisplayText } from '../../lib/decision-brief-view';
import { formatApprovalFailure } from '../../lib/approval-failure';
import { useOutcomePreview } from '../../lib/use-outcome-preview';
import { startSummaryWatch } from '../../lib/summary-watch';
import { InboxCheckin, ResponseStatusPanel } from './inbox-advisories';
import {
  INBOX_REASONS,
  fetchNeedsYouPage,
  fetchNeedsYouSummary,
  inboxHref,
  parseInboxFilters,
  postApprovalDecision,
  postClarificationDecision,
  postKnowledgeDecision,
  postReviewVerdict,
  type NeedsYouItem,
  type NeedsYouSummary,
} from '../../lib/needs-you-client';
import { inboxReturnToCandidateHref } from '../../lib/inbox-links';
import {
  NeedsYouCard,
  cardAnchor,
  inboxLandingHash,
  resolveInboxAnchor,
  REASON_TONES,
  formatWhen,
  itemTitle,
  relativeWhen,
  type CardDecision,
  type OutcomePreviewState,
} from './needs-you-card';

/** "あとで" is client-side only: it sets a card aside in this browser, never on the server. */
const DEFERRED_STORAGE_KEY = 'front-desk.deferred';

function readDeferred(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DEFERRED_STORAGE_KEY) || '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    );
  } catch {
    return new Set();
  }
}

function storeDeferred(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DEFERRED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Best effort: an unpersisted choice still applies until reload.
  }
}

export default function InboxPage() {
  return (
    <React.Suspense fallback={null}>
      <InboxView />
    </React.Suspense>
  );
}

/**
 * あなた待ち / Needs you — the one place a person decides (contract §2). Every
 * item and count comes from `/api/v1/needs-you`; the filters live in the URL
 * (`?reason=…&overdue=1`) so a link from anywhere opens the same view.
 */
function InboxView() {
  const { locale, t } = useConciergeI18n();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const filters = parseInboxFilters(searchParams);
  const filterKey = `${filters.reason ?? ''}|${filters.overdue ? 1 : 0}`;
  const c = React.useCallback(
    (key: string, params?: Record<string, string | number>) =>
      conciergeText(key as Parameters<typeof conciergeText>[0], locale, params),
    [locale]
  );
  const tt = React.useCallback(
    (key: string, params?: Record<string, string | number>) =>
      t(key as Parameters<typeof t>[0], params),
    [t]
  );

  const [summary, setSummary] = React.useState<NeedsYouSummary | null>(null);
  const [items, setItems] = React.useState<NeedsYouItem[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>();
  const [loadError, setLoadError] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [deferred, setDeferred] = React.useState<Set<string>>(new Set());

  React.useEffect(() => setDeferred(readDeferred()), []);

  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [nextSummary, page] = await Promise.all([
          fetchNeedsYouSummary(signal),
          fetchNeedsYouPage(
            parseInboxFilters(new URLSearchParams(filterKeyToQuery(filterKey))),
            undefined,
            signal
          ),
        ]);
        setSummary(nextSummary);
        setItems(page.items);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        setLoadError(false);
      } catch {
        // A failed read hides the queue (no acting on a stale list) and shows
        // the read-only retry; the open preview is dropped with it.
        if (!signal?.aborted) {
          setLoadError(true);
          setItems(null);
        }
      }
    },
    [filterKey]
  );

  React.useEffect(() => {
    setItems(null);
    const stop = startSummaryWatch({ refresh, onSummary: () => void refresh() });
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [refresh]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadMoreError(false);
    try {
      const page = await fetchNeedsYouPage(filters, nextCursor);
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      // The loaded cards stay; the failed page is announced next to its button.
      setLoadMoreError(true);
    }
  };

  const setAside = (item: NeedsYouItem, aside: boolean) =>
    setDeferred((previous) => {
      const next = new Set(previous);
      if (aside) next.add(item.id);
      else next.delete(item.id);
      storeDeferred(next);
      return next;
    });

  const decide = async (decision: CardDecision) => {
    const { item } = decision;
    const title = itemTitle(item, locale, tt);
    setBusyId(item.id);
    try {
      let message: string;
      switch (decision.kind) {
        case 'approval':
          await postApprovalDecision(item.approval!, decision.decision);
          message = t(
            decision.decision === 'approved' ? 'home.approved_notice' : 'home.rejected_notice',
            { title }
          );
          break;
        case 'review':
          await postReviewVerdict(item.outcome!.entry_id, decision.status, decision.note);
          message = t(
            decision.status === 'accepted'
              ? 'home.accepted_notice'
              : decision.status === 'rejected'
                ? 'home.rejected_notice'
                : 'home.changes_notice',
            { title }
          );
          break;
        case 'knowledge':
          message = await postKnowledgeDecision(item.knowledge!, decision.decision);
          break;
        case 'clarification':
          message = await postClarificationDecision(
            item.clarification!.mission_id,
            decision.decision,
            decision.note
          );
          break;
      }
      setNotice({ text: message });
      await refresh();
    } catch (error) {
      // Never show a raw error: approvals format the governed failure, the
      // other kinds map their helper's failure to a localized sentence.
      setNotice({
        text:
          decision.kind === 'approval'
            ? formatApprovalFailure(error, locale)
            : error instanceof Error && error.message === 'note_required'
              ? c('ia_inbox_error_note_required')
              : c(`ia_inbox_error_${decision.kind}`),
        error: true,
      });
    } finally {
      setBusyId(null);
    }
  };

  // A deep link (`/inbox#decide-approval-<id>` or `/inbox?request=<id>`) lands
  // on its card once the queue has loaded: reveal a set-aside card, use a
  // folded group's lead card.
  const landedHash = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!items || typeof window === 'undefined') return;
    const hash = inboxLandingHash(window.location.hash, window.location.search);
    if (!hash || landedHash.current === hash) return;
    const landing = resolveInboxAnchor(items, deferred, hash);
    if (!landing) return;
    if (landing.reveal) {
      const revealId = landing.reveal;
      setDeferred((previous) => {
        const next = new Set(previous);
        next.delete(revealId);
        storeDeferred(next);
        return next;
      });
      return;
    }
    landedHash.current = hash;
    const element = document.getElementById(landing.scrollTo);
    element?.scrollIntoView({ block: 'start' });
    element?.focus?.({ preventScroll: true });
  }, [items, deferred]);

  const visible = (items ?? []).filter((item) => !deferred.has(item.id));
  const setAsideItems = (items ?? []).filter((item) => deferred.has(item.id));
  // "N more" counts what is still waiting here: the total minus the cards set aside.
  const waitingCount = Math.max(0, total - setAsideItems.length);

  const outcomeItems = visible.flatMap((item) => (item.outcome ? [item.outcome] : []));
  const previewHook = useOutcomePreview(outcomeItems, filterKey);
  const preview: OutcomePreviewState = {
    id: previewHook.id,
    data: previewHook.data as OutcomePreviewState['data'],
    error: previewHook.error,
    busy: previewHook.busy,
    toggle: (outcome) => previewHook.toggle(outcome),
  };

  const header = <PageHeader title={c('ia_inbox_title')} subtitle={c('ia_inbox_lead')} />;

  if (loadError && !items) {
    return (
      <div className="kb-page" data-width="default">
        {header}
        <div role="alert">
          <Callout tone="danger" title={c('ia_inbox_load_error')} />
          <Button label={t('home.load_retry')} onClick={() => void refresh()} />
        </div>
      </div>
    );
  }

  const byReason = summary?.byReason;
  const reasonTabs = [
    {
      id: 'all',
      label: c('ia_inbox_filter_all'),
      count: summary?.total,
      href: inboxHref({ overdue: filters.overdue }, searchParams),
    },
    ...INBOX_REASONS.filter(
      (reason) => (byReason?.[reason] ?? 0) > 0 || filters.reason === reason
    ).map((reason) => ({
      id: reason,
      label: c(`ia_inbox_reason_${reason}`),
      count: byReason?.[reason] ?? 0,
      href: inboxHref({ reason, overdue: filters.overdue }, searchParams),
    })),
  ];
  const next = visible[0];
  const filtered = Boolean(filters.reason || filters.overdue);
  // An approval opened from a knowledge candidate (learning review) offers the
  // way back to that candidate's row in the library.
  const returnToCandidate = inboxReturnToCandidateHref(
    new URLSearchParams(searchParams.toString())
  );

  return (
    <div className="kb-page inbox-page" data-width="default">
      {header}
      {notice ? <Callout tone={notice.error ? 'danger' : 'success'} title={notice.text} /> : null}
      {returnToCandidate ? (
        <p className="inbox-return">
          <a href={returnToCandidate}>{c('ia_inbox_return_to_candidate')}</a>
        </p>
      ) : null}

      {summary ? (
        <div className="inbox-summary" aria-live="polite">
          <span className="inbox-summary__total">
            {c('ia_inbox_total', { count: summary.total })}
          </span>
          {summary.overdue > 0 ? (
            <Badge label={c('ia_inbox_overdue_count', { count: summary.overdue })} tone="danger" />
          ) : null}
          {summary.oldestWaitingSince ? (
            <span className="decide-muted" title={formatWhen(summary.oldestWaitingSince, locale)}>
              {c('ia_inbox_oldest', {
                value: relativeWhen(summary.oldestWaitingSince, locale) ?? '',
              })}
            </span>
          ) : null}
          <Disclosure summary={c('ia_inbox_count_how')}>
            <p className="decide-muted">{c('ia_inbox_count_definition')}</p>
          </Disclosure>
        </div>
      ) : null}

      {summary && summary.total > 0 ? (
        <div className="inbox-filters">
          <Tabs
            label={c('ia_inbox_filter_label')}
            active={filters.reason ?? 'all'}
            overflow="wrap"
            items={reasonTabs}
          />
          <Tabs
            label={c('ia_inbox_filter_overdue')}
            active={filters.overdue ? 'overdue' : 'any'}
            items={[
              {
                id: 'any',
                label: c('ia_inbox_filter_all'),
                href: inboxHref({ reason: filters.reason, overdue: false }, searchParams),
              },
              {
                id: 'overdue',
                label: c('ia_inbox_filter_overdue'),
                count: summary.overdue,
                href: inboxHref({ reason: filters.reason, overdue: true }, searchParams),
              },
            ]}
          />
        </div>
      ) : null}

      {items === null ? (
        <div className="decide-loading">
          <Skeleton shape="card" lines={3} label={c('ia_inbox_loading')} />
          <Skeleton shape="text" lines={4} label={c('ia_inbox_loading')} />
        </div>
      ) : visible.length === 0 ? (
        filtered ? (
          <NextAction
            state="empty"
            title={c('ia_inbox_empty_filtered')}
            primary={{ label: c('ia_inbox_filter_clear'), href: pathname || '/inbox' }}
          />
        ) : (
          <>
            <NextAction
              state="empty"
              title={c('ia_inbox_empty_title')}
              reason={c('ia_inbox_empty_reason')}
            />
            <Button
              label={t('home.ask_start')}
              variant="primary"
              onClick={() => window.dispatchEvent(new Event('concierge:open-dock'))}
            />
          </>
        )
      ) : (
        <>
          {next ? (
            <NextAction
              eyebrow={`${t('decide.next_eyebrow')} · ${c(`ia_inbox_reason_${next.reason}`)}`}
              title={itemTitle(next, locale, tt)}
              reason={
                waitingCount > 1 ? t('decide.next_more', { count: waitingCount - 1 }) : undefined
              }
              primary={{ label: t('decide.next_review'), href: `#${cardAnchor(next)}` }}
            />
          ) : null}
          <div className="decide-list">
            {visible.map((item) => (
              <NeedsYouCard
                key={item.id}
                item={item}
                locale={locale}
                t={tt}
                busy={busyId === item.id}
                isBusy={(id) => busyId === id}
                onDecide={decide}
                onLater={(target) => setAside(target, true)}
                preview={preview}
              />
            ))}
          </div>
          {nextCursor ? (
            <Button
              label={c('ia_inbox_load_more')}
              variant="secondary"
              onClick={() => void loadMore()}
            />
          ) : null}
          {loadMoreError ? (
            <div role="alert">
              <Callout tone="danger" title={c('ia_inbox_load_more_error')} />
            </div>
          ) : null}
        </>
      )}

      {setAsideItems.length > 0 ? (
        <Disclosure
          summary={frontDeskText('decide_deferred', locale, { count: setAsideItems.length })}
        >
          <ul className="decide-deferred-list">
            {setAsideItems.map((item) => (
              <li key={item.id} className="decide-deferred-item">
                <Badge
                  label={c(`ia_inbox_reason_${item.reason}`)}
                  tone={REASON_TONES[item.reason]}
                />
                <span className="decide-deferred-title">
                  {renderDisplayText(item.title, locale)}
                </span>
                <Button
                  label={frontDeskText('decide_undefer', locale)}
                  variant="ghost"
                  onClick={() => setAside(item, false)}
                />
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      <InboxCheckin />
      <ResponseStatusPanel />
    </div>
  );
}

function filterKeyToQuery(key: string): string {
  const [reason, overdue] = key.split('|');
  const params = new URLSearchParams();
  if (reason) params.set('reason', reason);
  if (overdue === '1') params.set('overdue', '1');
  return params.toString();
}
