'use client';

import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Callout, EmptyState, Skeleton } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../lib/i18n';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { withSelectedTenant } from '../../lib/tenant-context';
import { parseHelpAccess } from '../../lib/help-view';
import {
  REQUEST_PARAM,
  REQUESTS_INBOX_PATH,
  artifactKindKey,
  estimatedPercent,
  findRequestTarget,
  inboxStatusKey,
  isInboxStatus,
  itemTaskState,
  needsInboxDecision,
  parseRequestDetail,
  parseRequestsPayload,
  readableDeliveryTitle,
  requestHref,
  requestsApiPath,
  selectedCompany,
  taskStateHintKey,
  taskStateKey,
  type DeliveryTitleFacts,
  type RequestDetail,
  type RequestItem,
  type RequestsPayload,
  type RequestsSection,
} from '../../lib/requests-view';
import { OutcomeFiles } from '../outcome-files';
import { WorkInventoryPanel } from './work-inventory-panel';
import './requests.css';

type ListLoad =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; payload: RequestsPayload; path: string };
type DetailLoad =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'failed' }
  | { state: 'ready'; detail: RequestDetail };

function formatWhen(when: string | undefined, locale: ConciergeLocale): string {
  if (!when) return '';
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(localeToBcp47(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 仕事 › 依頼: the viewer's requests, moved from presence-studio's 進み具合
 * page (Kyberion server phase 2). Active requests show their recorded state,
 * latest recorded update and a phase estimate; delivered and done ones follow.
 * Selecting one shows its detail and history; `?request=<id>` (an item id or
 * the request correlation the secretary dock links with) opens it directly.
 * The 業務の自動化候補 panel follows the list.
 *
 * Deliverable decisions are not made here: a delivered item that waits for a
 * decision links to 受信箱, and only for a viewer who can open 受信箱.
 */
export function RequestsPanel() {
  const { t, locale } = useConciergeI18n();
  const ft = React.useCallback(
    (key: FrontDeskMessageKey, params?: Record<string, string | number>) =>
      frontDeskText(key, locale, params),
    [locale]
  );
  const router = useRouter();
  const pathname = usePathname() ?? '/work';
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const params = React.useMemo(() => new URLSearchParams(search), [search]);
  const listPath = requestsApiPath(params);
  const wanted = params.get(REQUEST_PARAM);
  const tenant = params.get('tenant');

  const [list, setList] = React.useState<ListLoad>({ state: 'loading' });
  // Bumped only by the refresh button: a refresh keeps the shown list.
  const [refreshCount, setRefreshCount] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('');
  const [detail, setDetail] = React.useState<DetailLoad>({ state: 'idle' });
  const [detailAttempt, setDetailAttempt] = React.useState(0);
  // Studio links used `#<id>`; the fragment is only known in the browser.
  const [hashId, setHashId] = React.useState<string | null>(null);
  // Tenant-dependent hrefs and access are known only after mount.
  const [inboxHref, setInboxHref] = React.useState(REQUESTS_INBOX_PATH);
  const [canOpenInbox, setCanOpenInbox] = React.useState(false);
  const detailHeading = React.useRef<HTMLHeadingElement>(null);
  const focusDetail = React.useRef(false);
  const handledRefresh = React.useRef(0);

  React.useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    try {
      setHashId(decodeURIComponent(raw));
    } catch {
      setHashId(null);
    }
  }, []);

  React.useEffect(() => {
    setInboxHref(withSelectedTenant(REQUESTS_INBOX_PATH, selectedCompany(params)));
  }, [params]);

  // 受信箱 access follows the selected tenant, exactly as the rail asks for it.
  React.useEffect(() => {
    let live = true;
    setCanOpenInbox(false);
    const url = withSelectedTenant(`/api/front-desk/nav?locale=${locale}`, tenant || null);
    void fetch(url, { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body) => {
        // Unknown access stays "no link": a viewer sees the status text only.
        if (live && body) setCanOpenInbox(parseHelpAccess(body).inbox && body.ok === true);
      })
      .catch(() => {
        /* no link; 受信箱 enforces its own role */
      });
    return () => {
      live = false;
    };
  }, [locale, tenant]);

  React.useEffect(() => {
    let live = true;
    // Explicit until its answer is handled, so StrictMode's second effect run
    // still treats a refresh as a refresh.
    const explicit = refreshCount !== handledRefresh.current;
    // A different scope (tenant switch) never shows the old company's list.
    setList((current) =>
      explicit && current.state === 'ready' && current.path === listPath
        ? current
        : { state: 'loading' }
    );
    if (explicit) setRefreshing(true);
    void fetch(listPath, { cache: 'no-store' })
      .then(async (response) => (response.ok ? parseRequestsPayload(await response.json()) : null))
      .catch(() => null)
      .then((payload) => {
        if (!live) return;
        handledRefresh.current = refreshCount;
        setList(payload ? { state: 'ready', payload, path: listPath } : { state: 'failed' });
        setRefreshing(false);
        // Announce only what an explicit refresh brought; a failure clears
        // 「更新中」 and is the danger callout's own alert.
        if (explicit) {
          setAnnouncement(
            payload ? ft('progress_filter_active', { count: payload.active.length }) : ''
          );
        }
      });
    return () => {
      live = false;
    };
    // `ft` is read when the answer arrives; a locale change is not a reload.
  }, [listPath, refreshCount]);

  const payload = list.state === 'ready' && list.path === listPath ? list.payload : null;
  const requested = wanted ?? hashId;
  const target = payload ? findRequestTarget(payload, requested) : null;
  const selected = target?.item ?? null;
  const selectedId = selected?.id ?? null;
  // Only an item of the list now in view is ever fetched.
  const detailPath = selectedId ? requestsApiPath(params, selectedId) : null;

  React.useEffect(() => {
    if (!detailPath) {
      setDetail({ state: 'idle' });
      return;
    }
    let live = true;
    setDetail({ state: 'loading' });
    void fetch(detailPath, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404 || response.status === 403) return 'unavailable' as const;
        if (!response.ok) return null;
        return parseRequestDetail(await response.json());
      })
      .catch(() => null)
      .then((result) => {
        if (!live) return;
        if (result === 'unavailable') setDetail({ state: 'unavailable' });
        else setDetail(result ? { state: 'ready', detail: result } : { state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [detailPath, detailAttempt]);

  React.useEffect(() => {
    if (!focusDetail.current || detail.state === 'loading') return;
    focusDetail.current = false;
    detailHeading.current?.focus();
  }, [detail.state, selectedId]);

  const refresh = () => {
    setAnnouncement(ft('progress_refreshing'));
    setRefreshCount((value) => value + 1);
    setDetailAttempt((value) => value + 1);
  };

  const select = (item: RequestItem) => {
    focusDetail.current = true;
    if (hashId) {
      setHashId(null);
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search
      );
    }
    router.replace(requestHref(pathname, params, item.id), { scroll: false });
  };

  const kindLabel = (key: Parameters<typeof t>[0]) => t(key);
  const titleOf = (section: RequestsSection, item: RequestItem) =>
    section === 'active' || (item as { kind?: string }).kind === 'task_session'
      ? item.title
      : readableDeliveryTitle(item as DeliveryTitleFacts, kindLabel);

  const statusBadge = (section: RequestsSection, item: RequestItem) => {
    const state = itemTaskState(item);
    if (state) return <Badge label={ft(taskStateKey(state))} tone="neutral" />;
    const status = (item as { status?: string }).status;
    if (isInboxStatus(status)) {
      return (
        <Badge
          label={t(inboxStatusKey(status))}
          tone={needsInboxDecision(item) ? 'warning' : 'neutral'}
        />
      );
    }
    return <Badge label={ft(section === 'done' ? 'progress_history' : 'tag_delivered')} />;
  };

  const row = (section: RequestsSection, item: RequestItem) => {
    const current = item.id === selectedId;
    const percent = section === 'active' ? estimatedPercent(item) : null;
    const latest = section === 'active' ? (item as { latest_update?: { text: string } }) : null;
    const when = formatWhen(item.when, locale);
    return (
      <li key={`${section}:${item.id}`}>
        <button
          type="button"
          className="requests-row"
          aria-current={current ? 'true' : undefined}
          onClick={() => select(item)}
        >
          <span className="requests-row__head">
            <span className="requests-row__title">{titleOf(section, item)}</span>
            {statusBadge(section, item)}
          </span>
          {latest?.latest_update?.text ? (
            <span className="requests-row__meta">{latest.latest_update.text}</span>
          ) : null}
          {when ? (
            <span className="requests-row__meta">{t('ia_work_requests_updated', { when })}</span>
          ) : null}
          {percent !== null ? (
            <span className="requests-row__estimate">
              <progress
                className="requests-row__bar"
                max={100}
                value={percent}
                aria-label={ft('progress_phase_estimate')}
              />
              <span className="requests-row__meta">
                {t('ia_work_requests_percent', { percent })}
              </span>
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const group = (
    section: RequestsSection,
    title: string,
    items: RequestItem[],
    empty: string,
    description?: string
  ) => (
    <section className="requests-group" aria-labelledby={`requests-${section}-heading`}>
      <h2 id={`requests-${section}-heading`} className="requests-heading">
        {title} <span className="requests-count">{ft('count_items', { count: items.length })}</span>
      </h2>
      {description ? <p className="requests-row__meta">{description}</p> : null}
      {items.length === 0 ? (
        <p className="requests-row__meta">{empty}</p>
      ) : (
        <ul className="requests-list">{items.map((item) => row(section, item))}</ul>
      )}
    </section>
  );

  const deliveryNote = (item: RequestItem, section: RequestsSection) => {
    if (section === 'active') return null;
    const status = (item as { status?: string }).status;
    const entryId = (item as { entry_id?: string }).entry_id;
    return (
      <div className="requests-detail__block">
        {isInboxStatus(status) ? (
          <p className="requests-row__meta">
            {t('ia_work_requests_inbox_status', { status: t(inboxStatusKey(status)) })}
          </p>
        ) : section === 'delivered' ? (
          <p className="requests-row__meta">{t('ia_work_requests_inbox_not_linked')}</p>
        ) : null}
        {needsInboxDecision(item) && canOpenInbox ? (
          <Button label={t('ia_work_requests_inbox_decide')} variant="primary" href={inboxHref} />
        ) : null}
        {entryId && (item as { downloadable?: boolean }).downloadable ? (
          <OutcomeFiles entryId={entryId} revision={item.when ?? ''} />
        ) : null}
      </div>
    );
  };

  const detailBody = (ready: RequestDetail, state: ReturnType<typeof itemTaskState>) => {
    // A delivery read on its own: its kind, not its raw file name or kind id.
    if (ready.artifact_kind !== undefined) {
      return (
        <p className="requests-row__meta">
          {t('ia_work_requests_kind_line', { kind: t(artifactKindKey(ready.artifact_kind)) })}
        </p>
      );
    }
    return (
      <>
        <section className="requests-detail__block" aria-labelledby="request-asked">
          <h3 id="request-asked" className="requests-subheading">
            {ft('progress_detail_requested')}
          </h3>
          <p className="requests-text">{ready.requested}</p>
        </section>
        <section className="requests-detail__block" aria-labelledby="request-recorded">
          <h3 id="request-recorded" className="requests-subheading">
            {ready.latest_update ? ft('progress_task_latest_update') : ft('progress_detail_now')}
          </h3>
          <p className="requests-text">{ready.latest_update?.text ?? ready.now}</p>
          {ready.kind === 'task_session' ? (
            <p className="requests-row__meta">{ft(taskStateHintKey(state))}</p>
          ) : null}
        </section>
        {ready.next?.length ? (
          <section className="requests-detail__block" aria-labelledby="request-next">
            <h3 id="request-next" className="requests-subheading">
              {ft('progress_detail_next')}
            </h3>
            <ul className="requests-bullets">
              {ready.next.map((line, index) => (
                <li key={index} className="requests-text">
                  {line}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {ready.log.length ? (
          <section className="requests-detail__block" aria-labelledby="request-log">
            <h3 id="request-log" className="requests-subheading">
              {ft('progress_detail_log')}
            </h3>
            <ol className="requests-log">
              {ready.log.map((entry, index) => (
                <li key={index}>
                  {entry.when ? (
                    <time className="requests-row__meta" dateTime={entry.when}>
                      {formatWhen(entry.when, locale)}
                    </time>
                  ) : null}
                  <p className="requests-text">{entry.text}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </>
    );
  };

  const detailPanel = () => {
    if (!payload) return null;
    if (!selected || !target) {
      return (
        <p className="requests-row__meta">
          {requested ? ft('progress_request_pending') : ft('progress_select_hint')}
        </p>
      );
    }
    const state = detail.state === 'ready' ? detail.detail.task_state : itemTaskState(selected);
    return (
      <section aria-labelledby="request-detail-heading">
        <h2
          id="request-detail-heading"
          ref={detailHeading}
          tabIndex={-1}
          className="requests-heading requests-detail__title"
        >
          {titleOf(target.section, selected)}
        </h2>
        <div className="requests-detail__state">{statusBadge(target.section, selected)}</div>
        {detail.state === 'loading' ? <Skeleton shape="text" /> : null}
        {detail.state === 'unavailable' ? (
          <Callout tone="warning" title={ft('progress_item_unavailable')} />
        ) : null}
        {detail.state === 'failed' ? (
          <div className="requests-detail__block">
            <Callout
              tone="danger"
              title={ft('progress_detail_failed', { title: titleOf(target.section, selected) })}
            />
            <Button
              label={ft('progress_detail_retry')}
              onClick={() => setDetailAttempt((value) => value + 1)}
            />
          </div>
        ) : null}
        {detail.state === 'ready' ? detailBody(detail.detail, state) : null}
        {deliveryNote(selected, target.section)}
        {target.section === 'active' && payload.mirror_href ? (
          <a className="requests-link" href={payload.mirror_href}>
            {ft('progress_open_mirror')}
          </a>
        ) : null}
      </section>
    );
  };

  const waiting = payload ? payload.delivered.filter(needsInboxDecision).length : 0;

  return (
    <section className="requests" aria-label={t('ia_work_requests_list_label')}>
      <div className="requests-toolbar">
        <p className="requests-row__meta">{ft('progress_recorded_subtitle')}</p>
        <Button
          label={ft('progress_refresh')}
          disabled={refreshing || list.state === 'loading'}
          onClick={refresh}
        />
      </div>
      {/* The one live region: announced only for an explicit refresh. */}
      <p className="kb-visually-hidden" role="status">
        {announcement}
      </p>
      {list.state === 'failed' ? (
        <div className="requests-detail__block">
          <Callout tone="danger" title={ft('progress_load_failed')} />
          <Button label={ft('progress_refresh')} onClick={refresh} />
        </div>
      ) : !payload ? (
        <Skeleton shape="table" />
      ) : payload.active.length + payload.delivered.length + payload.done.length === 0 ? (
        <EmptyState title={ft('progress_empty_active')} />
      ) : (
        <div className="requests-columns">
          <div className="requests-list-col">
            {group('active', ft('progress_open_work'), payload.active, ft('progress_empty_active'))}
            {group(
              'delivered',
              ft('progress_delivered_title'),
              payload.delivered,
              ft('progress_empty_delivered'),
              waiting > 0 ? ft('progress_delivered_waiting', { count: waiting }) : undefined
            )}
            {group(
              'done',
              ft('progress_filter_done'),
              payload.done,
              t('ia_work_requests_empty_done')
            )}
          </div>
          <div className="requests-detail">{detailPanel()}</div>
        </div>
      )}
      <WorkInventoryPanel search={search} />
    </section>
  );
}
