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
} from '../lib/customer-decision-navigation';
import { useCustomerDecisionView } from '../lib/customer-decision-view-client';
import { CustomerDecisionOverviewBody } from './CustomerDecisionOverviewCard';
import { CustomerDecisionCasePanel } from './CustomerDecisionCaseDetail';
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

/** The drill-down target an activated link or row opens, if any. */
function drillDownTarget(target: EventTarget | null, container: HTMLElement): string | null {
  if (!(target instanceof Element)) return null;
  const opener = target.closest('a[href], tr[data-href]');
  if (!opener || !container.contains(opener)) return null;
  return opener.getAttribute('href') ?? opener.getAttribute('data-href');
}

/**
 * The card: the overview of `tenant`, or — from the address bar (`cd_view`,
 * `cd_case`, `cd_agenda`, `cd_date`) — a case, one of its agenda sets, or the
 * learning report. Drill-down links navigate in place (router push, scroll
 * kept); Back returns focus to the row or link that opened the view.
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
    const restore = (): boolean => {
      const opener = Array.from(
        container.querySelectorAll<HTMLElement>('a[href], tr[data-href]')
      ).find(
        (element) => (element.getAttribute('href') ?? element.getAttribute('data-href')) === href
      );
      opener?.focus();
      return Boolean(opener);
    };
    if (restore()) return;
    // The overview loads again after Back: focus the opener once its row is there.
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), FOCUS_RESTORE_WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [selection]);

  let body: React.ReactNode;
  if (selection.view === 'case')
    body = (
      <CustomerDecisionCaseDetail
        tenant={tenant}
        caseId={selection.caseId}
        agendaId={selection.agendaId}
        locale={locale}
        hrefs={hrefs}
      />
    );
  else if (selection.view === 'learning')
    body = (
      <CustomerDecisionLearningPanel
        tenant={tenant}
        organizationId={organizationId || tenant}
        date={selection.date}
        locale={locale}
        hrefs={hrefs}
        candidates={learningCandidates}
      />
    );
  else body = <CustomerDecisionOverviewBody tenant={tenant} locale={locale} hrefs={hrefs} />;

  return (
    <A2UIActionProvider
      onAction={parent.onAction}
      linkComponent={CustomerDecisionLink}
      navigate={navigate}
    >
      <div
        ref={containerRef}
        className="chronos-cd-host"
        onClickCapture={(event) => remember(event.target)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter') remember(event.target);
        }}
      >
        {body}
      </div>
    </A2UIActionProvider>
  );
}
