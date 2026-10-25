'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { A2UIActionProvider, useA2UIActions, type A2UILinkProps } from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import type { SupportedLocale } from '../lib/ux-vocabulary';
import {
  customerDecisionHrefs,
  readCustomerDecisionSelection,
  type CustomerDecisionHrefs,
  type CustomerDecisionSelection,
} from '../lib/customer-decision-navigation';
import { useCustomerDecisionView } from '../lib/customer-decision-view-client';
import { CustomerDecisionOverviewBody } from './CustomerDecisionOverviewCard';
import {
  CustomerDecisionCasePanel,
  CustomerDecisionFocusOnOpen,
} from './CustomerDecisionCaseDetail';
import { CustomerDecisionAgendaPanel } from './CustomerDecisionAgendaDetail';
import {
  CustomerDecisionLearningPanel,
  type CustomerDecisionLearningCandidate,
} from './CustomerDecisionLearningPanel';

/**
 * CD-12: the "customer decisions" card of the organization view and its
 * drill-down — the overview, a case, one of its agenda sets, or the learning
 * report, chosen from the address bar. Only this module knows the router;
 * the views are presentational and take their hrefs.
 */

/**
 * The case view, or one of its agenda sets (`agendaId`, a client-side
 * selection of the same response).
 */
export function CustomerDecisionCaseDetail({
  tenant,
  caseId,
  agendaId,
  locale,
  hrefs,
}: {
  tenant: string;
  caseId: string;
  agendaId?: string;
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
}) {
  const { state, retry } = useCustomerDecisionView('case', tenant, caseId);
  if (agendaId)
    return (
      <CustomerDecisionAgendaPanel
        state={state}
        tenant={tenant}
        caseId={caseId}
        agendaId={agendaId}
        locale={locale}
        hrefs={hrefs}
        onRetry={retry}
      />
    );
  return (
    <CustomerDecisionCasePanel
      state={state}
      tenant={tenant}
      caseId={caseId}
      locale={locale}
      hrefs={hrefs}
      onRetry={retry}
    />
  );
}

/** How long Back waits for the overview to load again before giving up on refocusing the opener. */
const FOCUS_RESTORE_WAIT_MS = 10_000;

/** Drill-down links keep the scroll position (the view swaps in place). */
function CustomerDecisionLink({ href, children, ...rest }: A2UILinkProps) {
  return (
    <Link href={href} scroll={false} {...rest}>
      {children}
    </Link>
  );
}

/** The DOM a drill-down opener needs (an `Element`; duck-typed so it is testable without a DOM). */
export interface DrillDownElement {
  getAttribute(name: string): string | null;
  closest(selector: string): DrillDownElement | null;
}

export const DRILL_DOWN_OPENER_SELECTOR = 'a[href], tr[data-href]';

function openerHref(element: DrillDownElement): string | null {
  return element.getAttribute('href') ?? element.getAttribute('data-href');
}

/** The href an activated link or row inside `container` opens, if any. */
export function drillDownTarget(
  target: unknown,
  container: { contains: (node: never) => boolean }
): string | null {
  if (!target || typeof (target as DrillDownElement).closest !== 'function') return null;
  const opener = (target as DrillDownElement).closest(DRILL_DOWN_OPENER_SELECTOR);
  const contains = container.contains.bind(container) as (node: unknown) => boolean;
  if (!opener || !contains(opener)) return null;
  return openerHref(opener);
}

/** Focuses the link or row in `container` that opens `href`; false when it is not there (yet). */
export function focusDrillDownOpener(
  container: {
    querySelectorAll(selector: string): ArrayLike<DrillDownElement & { focus(): void }>;
  },
  href: string
): boolean {
  const opener = Array.from(container.querySelectorAll(DRILL_DOWN_OPENER_SELECTOR)).find(
    (element) => openerHref(element) === href
  );
  opener?.focus();
  return Boolean(opener);
}

/**
 * Whether the card shows a view the viewer navigated to inside the page (the
 * query differs from the one the page loaded with); a direct load or a
 * refresh does not move focus.
 */
export function isInAppNavigation(initialQuery: string, query: string): boolean {
  return initialQuery !== query;
}

/** The view a selection shows (rendered statically in tests). */
export function CustomerDecisionSelectionView({
  selection,
  tenant,
  organizationId,
  learningCandidates,
  locale,
  hrefs,
}: {
  selection: CustomerDecisionSelection;
  tenant: string;
  organizationId?: string;
  learningCandidates?: readonly CustomerDecisionLearningCandidate[];
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
}) {
  if (selection.view === 'case')
    return (
      <CustomerDecisionCaseDetail
        tenant={tenant}
        caseId={selection.caseId}
        agendaId={selection.agendaId}
        locale={locale}
        hrefs={hrefs}
      />
    );
  if (selection.view === 'learning')
    return (
      <CustomerDecisionLearningPanel
        tenant={tenant}
        organizationId={organizationId || tenant}
        date={selection.date}
        locale={locale}
        hrefs={hrefs}
        candidates={learningCandidates}
      />
    );
  return <CustomerDecisionOverviewBody tenant={tenant} locale={locale} hrefs={hrefs} />;
}

/**
 * The card: the overview of `tenant`, or — from the address bar (`cd_view`,
 * `cd_case`, `cd_agenda`, `cd_date`) — a case, one of its agenda sets, or the
 * learning report. Drill-down links navigate in place (router push, scroll
 * kept); after an in-app navigation the opened view's heading takes focus,
 * and Back returns focus to the row or link that opened the view.
 */
export function CustomerDecisionCard({
  tenant,
  organizationId,
  learningCandidates,
}: {
  tenant: string;
  /** The tenant's organization (its slug, unless the model says otherwise). */
  organizationId?: string;
  /** The organization model's learning candidates (their status on the learning view). */
  learningCandidates?: readonly CustomerDecisionLearningCandidate[];
}) {
  const locale = useChronosLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const initialQuery = React.useRef(query);
  const focusOnOpen = isInAppNavigation(initialQuery.current, query);
  const parent = useA2UIActions();
  const selection = React.useMemo(
    () => readCustomerDecisionSelection(new URLSearchParams(query)),
    [query]
  );
  const hrefs = React.useMemo(
    () => customerDecisionHrefs(pathname || '/', new URLSearchParams(query)),
    [pathname, query]
  );
  const navigate = React.useCallback(
    (href: string) => router.push(href, { scroll: false }),
    [router]
  );

  const containerRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<string | null>(null);
  const remember = (target: EventTarget | null) => {
    if (selection.view !== 'overview' || !containerRef.current) return;
    const href = drillDownTarget(target, containerRef.current);
    if (href) openerRef.current = href;
  };
  React.useEffect(() => {
    const href = openerRef.current;
    const container = containerRef.current;
    if (selection.view !== 'overview' || !href || !container) return;
    openerRef.current = null;
    if (focusDrillDownOpener(container, href)) return;
    // The overview loads again after Back: focus the opener once its row is there.
    const observer = new MutationObserver(() => {
      if (focusDrillDownOpener(container, href)) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), FOCUS_RESTORE_WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [selection]);

  return (
    <A2UIActionProvider
      onAction={parent.onAction}
      linkComponent={CustomerDecisionLink}
      navigate={navigate}
    >
      <CustomerDecisionFocusOnOpen.Provider value={focusOnOpen}>
        <div
          ref={containerRef}
          className="chronos-cd-host"
          onClickCapture={(event) => remember(event.target)}
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter') remember(event.target);
          }}
        >
          <CustomerDecisionSelectionView
            selection={selection}
            tenant={tenant}
            organizationId={organizationId}
            learningCandidates={learningCandidates}
            locale={locale}
            hrefs={hrefs}
          />
        </div>
      </CustomerDecisionFocusOnOpen.Provider>
    </A2UIActionProvider>
  );
}
