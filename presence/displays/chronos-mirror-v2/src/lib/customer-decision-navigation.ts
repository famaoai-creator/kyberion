/**
 * CD-12 drill-down: which customer-decision view the organization page shows,
 * kept in the address bar so a view is a deep link and Back works.
 *
 *   cd_view=case&cd_case=<case>[&cd_agenda=<agenda>]   a case (and one of its agenda sets)
 *   cd_view=learning[&cd_date=YYYY-MM-DD]             the learning report
 *
 * These are navigation hints only: the routes resolve the viewer's tenant
 * server-side and refuse anything outside it. A malformed value falls back
 * to the overview. The `cd_*` parameters belong to one tenant, so they are
 * dropped whenever the tenant (or organization) selection changes.
 */
import { isCustomerDecisionCaseId } from './customer-decision-case-response';
import { isLearningReportDate } from './customer-decision-learning-response';

export const CUSTOMER_DECISION_URL_PARAMS = ['cd_view', 'cd_case', 'cd_agenda', 'cd_date'] as const;

export type CustomerDecisionSelection =
  | { view: 'overview' }
  | { view: 'case'; caseId: string; agendaId?: string }
  | { view: 'learning'; date?: string };

/** Agenda ids are `agd-<hex16>`; any id-shaped value is accepted, the view checks it exists. */
const AGENDA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;

interface ParamReader {
  get(name: string): string | null;
}

export function readCustomerDecisionSelection(params: ParamReader): CustomerDecisionSelection {
  const view = params.get('cd_view');
  if (view === 'case') {
    const caseId = params.get('cd_case')?.trim() ?? '';
    if (!isCustomerDecisionCaseId(caseId)) return { view: 'overview' };
    const agendaId = params.get('cd_agenda')?.trim() ?? '';
    return AGENDA_ID_PATTERN.test(agendaId) ? { view, caseId, agendaId } : { view, caseId };
  }
  if (view === 'learning') {
    const date = params.get('cd_date')?.trim() ?? '';
    return isLearningReportDate(date) ? { view, date } : { view };
  }
  return { view: 'overview' };
}

/** The query without any `cd_*` parameter (tenant switches, leaving the card). */
export function clearCustomerDecisionSelection(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of CUSTOMER_DECISION_URL_PARAMS) next.delete(name);
  return next;
}

export function withCustomerDecisionSelection(
  params: URLSearchParams,
  selection: CustomerDecisionSelection
): URLSearchParams {
  const next = clearCustomerDecisionSelection(params);
  if (selection.view === 'case') {
    next.set('cd_view', 'case');
    next.set('cd_case', selection.caseId);
    if (selection.agendaId) next.set('cd_agenda', selection.agendaId);
  } else if (selection.view === 'learning') {
    next.set('cd_view', 'learning');
    if (selection.date) next.set('cd_date', selection.date);
  }
  return next;
}

function hrefOf(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return `${pathname || '/'}${query ? `?${query}` : ''}`;
}

/** The href of a customer-decision view on the current page (other parameters kept, values encoded). */
export function customerDecisionHref(
  pathname: string,
  current: URLSearchParams,
  selection: CustomerDecisionSelection
): string {
  return hrefOf(pathname, withCustomerDecisionSelection(current, selection));
}

/** The hrefs a drill-down view links to (built from the current address). */
export interface CustomerDecisionHrefs {
  overview: string;
  learningOf: (date?: string) => string;
  caseOf: (caseId: string) => string;
  agendaOf: (caseId: string, agendaId: string) => string;
  missionOf: (missionId: string) => string;
}

export function customerDecisionHrefs(
  pathname: string,
  current: URLSearchParams
): CustomerDecisionHrefs {
  return {
    overview: customerDecisionHref(pathname, current, { view: 'overview' }),
    learningOf: (date) => customerDecisionHref(pathname, current, { view: 'learning', date }),
    caseOf: (caseId) => customerDecisionHref(pathname, current, { view: 'case', caseId }),
    agendaOf: (caseId, agendaId) =>
      customerDecisionHref(pathname, current, { view: 'case', caseId, agendaId }),
    missionOf: (missionId) => customerDecisionMissionHref(pathname, current, missionId),
  };
}

/** The missions section focused on one mission (the tenant / organization selection kept). */
export function customerDecisionMissionHref(
  pathname: string,
  current: URLSearchParams,
  missionId: string
): string {
  const next = clearCustomerDecisionSelection(current);
  next.set('section', 'missions');
  next.set('mission', missionId);
  return hrefOf(pathname, next);
}
