'use client';

import { withPageProjectScope } from '../lib/project-selection';
import * as React from 'react';
import { PageHeader } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { frontDeskFetch } from '../lib/front-desk-fetch';
import { TENANT_CHANGED_EVENT } from '../lib/tenant-context';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { SETUP_CHECKLIST_PATH, parseSetupChecklistResponse } from '../lib/setup-checklist-client';
import type { SetupChecklist as SetupChecklistData } from '@agent/core/surface/setup-checklist-model';
import {
  loadFailureFromStatus,
  parseHomeDashboard,
  parseNeedsYouSummary,
  type HomeDashboard,
  type HomeLoadFailure,
  type NeedsYouSummary,
} from '../lib/home-view';
import {
  AgentsTile,
  CostTile,
  DeliverablesTile,
  HealthTile,
  KeyResultsTile,
  MissionsTile,
  NeedsYouTile,
  SetupChecklist,
  type HomeTranslate,
  type Loadable,
} from './home-parts';
import './home.css';

const REFRESH_MS = 60_000;

function useLoadable<T>(
  path: string,
  parse: (body: unknown) => T | null,
  version: number,
  /** Carries the page's project narrowing (`organization_id` + `project_id`). */
  projectScoped = false
): Loadable<T> & { reload: () => void } {
  const [state, setState] = React.useState<Loadable<T>>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const hasData = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController();
    // A background refresh keeps the last good numbers on screen.
    if (!hasData.current) setState({ state: 'loading' });
    frontDeskFetch(projectScoped ? withPageProjectScope(path) : path, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        const parsed = response.ok ? parse(body) : null;
        if (parsed === null) {
          hasData.current = false;
          setState({
            state: 'error',
            failure: loadFailureFromStatus(response.ok ? 500 : response.status),
          });
          return;
        }
        hasData.current = true;
        setState({ state: 'ready', data: parsed });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        hasData.current = false;
        setState({ state: 'error', failure: 'failed' as HomeLoadFailure });
      });
    return () => controller.abort();
  }, [path, parse, version, attempt, projectScoped]);
  const reload = React.useCallback(() => {
    hasData.current = false;
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, reload };
}

const parseChecklist = (body: unknown): SetupChecklistData | null =>
  parseSetupChecklistResponse(body) ?? null;

/**
 * ホーム — the situation at a glance (MSN-SHELL-IA-20261105 contract §3):
 * setup (only while incomplete) → needs you → agents → missions → health →
 * organization KRs → cost → recent deliverables. Every tile drills down to
 * the one place that lists it. Dashboard numbers come from ONE server read
 * (`/api/v1/home`); the needs-you count has its own single source.
 */
export default function HomePage() {
  const { t, locale } = useConciergeI18n();
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    const bump = () => setVersion((n) => n + 1);
    window.addEventListener(TENANT_CHANGED_EVENT, bump);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') bump();
    }, REFRESH_MS);
    return () => {
      window.removeEventListener(TENANT_CHANGED_EVENT, bump);
      window.clearInterval(timer);
    };
  }, []);

  const home = useLoadable<HomeDashboard>('/api/v1/home', parseHomeDashboard, version, true);
  const needs = useLoadable<NeedsYouSummary>(
    '/api/v1/needs-you/summary',
    parseNeedsYouSummary,
    version,
    true
  );
  // Setup steps come from the one settings checklist (`setup.checklist`), so
  // Home and 設定 › はじめに always agree and link to the same cards.
  const checklist = useLoadable<SetupChecklistData>(SETUP_CHECKLIST_PATH, parseChecklist, version);
  const translate = t as HomeTranslate;
  const bcp47 = localeToBcp47(locale);
  const updated =
    home.state === 'ready'
      ? new Date(home.data.generatedAt).toLocaleTimeString(bcp47, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';

  return (
    <div className="kb-page kb-home" data-width="wide">
      <PageHeader
        title={t('ia_home_title')}
        subtitle={
          updated
            ? `${t('ia_home_lead')} ${t('ia_home_updated', { time: updated })}`
            : t('ia_home_lead')
        }
      />
      <div className="kb-home__grid">
        {checklist.state === 'ready' ? (
          <SetupChecklist t={translate} locale={locale} checklist={checklist.data} />
        ) : null}
        <NeedsYouTile t={translate} bcp47={bcp47} summary={needs} onRetry={needs.reload} />
        <AgentsTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
        <MissionsTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
        <HealthTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
        <KeyResultsTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
        <CostTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
        <DeliverablesTile t={translate} bcp47={bcp47} home={home} onRetry={home.reload} />
      </div>
    </div>
  );
}
