'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, Callout, EmptyState, KbChart, Section, Skeleton } from '@agent/shared-ui';
import { frontDeskText, type ConciergeLocale, type ConciergeMessageKey } from '../lib/i18n';
import {
  SETUP_CHECKLIST_ANCHORS,
  type SetupChecklist as SetupChecklistData,
  type SetupChecklistStepId,
} from '@agent/core/surface/setup-checklist-model';
import {
  NEEDS_YOU_REASONS,
  barPercent,
  inboxHref,
  missionHref,
  relativeTime,
  settingsHref,
  windowDelta,
  workHref,
  type HomeAgentState,
  type HomeDashboard,
  type HomeLoadFailure,
  type MissionOpenState,
  type NeedsYouSummary,
} from '../lib/home-view';
import type { HomeSection } from '../lib/home-dashboard';

export type HomeTranslate = (
  key: ConciergeMessageKey,
  params?: Record<string, string | number>
) => string;

export type Loadable<T> =
  { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; failure: HomeLoadFailure };

type HomeLoadable = Loadable<HomeDashboard>;

interface TileProps {
  t: HomeTranslate;
  home: HomeLoadable;
  onRetry: () => void;
  bcp47?: string;
}

const fmtNumber = (bcp47: string, value: number, digits = 0) =>
  new Intl.NumberFormat(bcp47, { maximumFractionDigits: digits }).format(value);
const fmtUsd = (bcp47: string, value: number) =>
  new Intl.NumberFormat(bcp47, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);

// ---------------------------------------------------------------------------
// Frame and the three non-data states (loading ≠ zero ≠ couldn't load)
// ---------------------------------------------------------------------------

function Tile({
  span,
  title,
  description,
  action,
  children,
  testId,
}: {
  span: 'full' | 'wide' | 'narrow' | 'half';
  title: string;
  description?: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="kb-home__tile" data-span={span} data-testid={testId}>
      <Section
        title={title}
        description={description}
        actions={action ? [{ label: action.label, href: action.href }] : undefined}
      >
        {children}
      </Section>
    </div>
  );
}

export function LoadFailure({
  t,
  failure,
  onRetry,
}: {
  t: HomeTranslate;
  failure: HomeLoadFailure;
  onRetry: () => void;
}) {
  if (failure === 'signin')
    return (
      <Callout
        tone="warning"
        title={t('ia_home_error_signin')}
        action={{ label: t('ia_home_signin'), href: '/signin' }}
      />
    );
  if (failure === 'forbidden')
    return <Callout tone="warning" title={t('ia_home_error_forbidden')} />;
  return (
    <div className="kb-home__failure" data-failure={failure}>
      <Callout
        tone="warning"
        title={t(failure === 'busy' ? 'ia_home_error_busy_title' : 'ia_home_error_failed_title')}
        body={t(failure === 'busy' ? 'ia_home_error_busy_body' : 'ia_home_error_failed_body')}
      >
        <Button label={t('ia_home_retry')} variant="secondary" onClick={onRetry} />
      </Callout>
    </div>
  );
}

function Loading({ t, lines = 3 }: { t: HomeTranslate; lines?: number }) {
  return <Skeleton shape="card" lines={lines} label={t('ia_home_loading')} />;
}

/**
 * Loading / failed / this tile's source unavailable, else the tile content.
 * Each state looks different from a real zero.
 */
function HomeState({
  t,
  home,
  section,
  onRetry,
  children,
}: {
  t: HomeTranslate;
  home: HomeLoadable;
  section: HomeSection;
  onRetry: () => void;
  children: (data: HomeDashboard) => React.ReactNode;
}) {
  if (home.state === 'loading') return <Loading t={t} />;
  if (home.state === 'error') return <LoadFailure t={t} failure={home.failure} onRetry={onRetry} />;
  if (home.data.unavailable.includes(section))
    return (
      <div className="kb-home__failure" data-failure="unavailable">
        <Callout
          tone="warning"
          title={t('ia_home_tile_unavailable_title')}
          body={t('ia_home_tile_unavailable_body')}
        >
          <Button label={t('ia_home_retry')} variant="secondary" onClick={onRetry} />
        </Callout>
      </div>
    );
  return <>{children(home.data)}</>;
}

// ---------------------------------------------------------------------------
// Encodings: length on a common baseline (bars), stacked share, sparklines
// ---------------------------------------------------------------------------

interface BarRow {
  key: string;
  label: string;
  value: number;
  valueText: string;
  href: string;
}

/** Horizontal bars on one baseline; each row is a link, the number is text. */
function BarRows({ rows, label }: { rows: BarRow[]; label: string }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <ul className="kb-home__bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <Link className="kb-home__bar-row" href={row.href} data-key={row.key}>
            <span className="kb-home__bar-label">{row.label}</span>
            <span className="kb-home__bar-track" aria-hidden="true">
              <span
                className="kb-home__bar-fill"
                style={{ '--kb-home-bar': `${barPercent(row.value, max)}%` } as React.CSSProperties}
              />
            </span>
            <span className="kb-home__bar-value">{row.valueText}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Sparkline({ points, label }: { points: Array<number | null>; label: string }) {
  return (
    <span className="kb-home__spark">
      <KbChart type="ui:sparkline" props={{ points, label }} />
    </span>
  );
}

function Delta({ t, delta }: { t: HomeTranslate; delta: ReturnType<typeof windowDelta> }) {
  return (
    <span className="kb-home__delta" data-direction={delta?.direction}>
      {delta
        ? t('ia_home_health_vs_previous', { delta: delta.text })
        : t('ia_home_health_no_previous')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 1. Setup checklist (only while incomplete)
// ---------------------------------------------------------------------------

/** The step labels 設定 › はじめに uses, so Home and settings name steps alike. */
const SETUP_STEP_KEYS = {
  identity: 'ia_settings_step_identity',
  reasoning: 'ia_settings_step_reasoning',
  autonomy: 'ia_settings_step_autonomy',
  notifications: 'ia_settings_step_notifications',
  first_project: 'ia_settings_step_first_project',
  budget: 'ia_settings_step_budget',
  trial_mission: 'ia_settings_step_trial_mission',
} as const satisfies Record<SetupChecklistStepId, string>;

/**
 * The remaining setup steps, in the required order, each opening its
 * settings card (`/settings#<anchor>`). Hidden once the checklist is done.
 */
export function SetupChecklist({
  t,
  locale,
  checklist,
}: {
  t: HomeTranslate;
  locale: ConciergeLocale;
  checklist: SetupChecklistData;
}) {
  if (checklist.complete) return null;
  const open = checklist.steps.filter((step) => step.status !== 'done');
  if (open.length === 0) return null;
  return (
    <Tile
      span="full"
      testId="home-setup"
      title={t('ia_home_setup_title')}
      description={t('ia_home_setup_lead', { done: checklist.done, total: checklist.total })}
    >
      <progress
        className="kb-home__progress"
        value={checklist.done}
        max={checklist.total}
        aria-label={t('ia_home_setup_progress_label')}
      />
      <ol className="kb-home__steps">
        {open.map((step) => (
          <li key={step.id}>
            <Link className="kb-home__step" href={settingsHref(`#${step.anchor}`)}>
              <span className="kb-home__step-mark" aria-hidden="true" />
              <span>
                {frontDeskText(
                  SETUP_STEP_KEYS[step.id] as Parameters<typeof frontDeskText>[0],
                  locale
                )}
              </span>
              <span className="kb-home__link">{t('setup.org_ready_go')} →</span>
            </Link>
          </li>
        ))}
      </ol>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 2. Needs you — the only red on the page (overdue)
// ---------------------------------------------------------------------------

const REASON_KEYS = {
  approval: 'ia_home_reason_approval',
  decision: 'ia_home_reason_decision',
  review: 'ia_home_reason_review',
  knowledge: 'ia_home_reason_knowledge',
  clarification: 'ia_home_reason_clarification',
  failure: 'ia_home_reason_failure',
} as const satisfies Record<(typeof NEEDS_YOU_REASONS)[number], ConciergeMessageKey>;

export function NeedsYouTile({
  t,
  bcp47,
  summary,
  onRetry,
}: {
  t: HomeTranslate;
  bcp47: string;
  summary: Loadable<NeedsYouSummary>;
  onRetry: () => void;
}) {
  const action = { label: t('ia_home_needs_open'), href: inboxHref() };
  let body: React.ReactNode;
  if (summary.state === 'loading') body = <Loading t={t} lines={2} />;
  else if (summary.state === 'error')
    body =
      summary.failure === 'signin' || summary.failure === 'forbidden' ? (
        <LoadFailure t={t} failure={summary.failure} onRetry={onRetry} />
      ) : (
        <div className="kb-home__failure" data-failure={summary.failure}>
          <Callout
            tone="warning"
            title={t(
              summary.failure === 'busy'
                ? 'ia_home_error_busy_title'
                : 'ia_home_needs_unavailable_title'
            )}
            body={t('ia_home_needs_unavailable_body')}
          >
            <Button label={t('ia_home_retry')} variant="secondary" onClick={onRetry} />
          </Callout>
        </div>
      );
  else if (summary.data.total === 0)
    body = (
      <EmptyState
        title={t('ia_home_needs_empty_title')}
        body={t('ia_home_needs_empty_body')}
        action={action}
      />
    );
  else {
    const data = summary.data;
    const rows = NEEDS_YOU_REASONS.filter((reason) => data.byReason[reason] > 0).map((reason) => ({
      key: reason,
      label: t(REASON_KEYS[reason]),
      value: data.byReason[reason],
      valueText: fmtNumber(bcp47, data.byReason[reason]),
      href: inboxHref({ reason }),
    }));
    body = (
      <div className="kb-home__needs">
        <div className="kb-home__headline">
          <Link className="kb-home__big" href={inboxHref()}>
            <span className="kb-home__big-value">{fmtNumber(bcp47, data.total)}</span>
            <span className="kb-home__big-label">{t('ia_home_needs_total_label')}</span>
          </Link>
          {data.overdue > 0 ? (
            <Link className="kb-home__overdue" href={inboxHref({ overdue: true })}>
              {t('ia_home_needs_overdue', { count: fmtNumber(bcp47, data.overdue) })}
            </Link>
          ) : (
            <span className="kb-home__muted">{t('ia_home_needs_none_overdue')}</span>
          )}
          {data.oldestWaitingSince ? (
            <span className="kb-home__muted">
              {t('ia_home_needs_oldest', { time: relativeTime(data.oldestWaitingSince, bcp47) })}
            </span>
          ) : null}
        </div>
        <BarRows rows={rows} label={t('ia_home_needs_by_reason')} />
      </div>
    );
  }
  return (
    <Tile span="full" testId="home-needs" title={t('ia_home_needs_title')} action={action}>
      {body}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 3. Agents — one stacked bar
// ---------------------------------------------------------------------------

const AGENT_STATES: HomeAgentState[] = ['working', 'waiting', 'error', 'idle'];
const AGENT_KEYS = {
  working: 'ia_home_agent_working',
  waiting: 'ia_home_agent_waiting',
  error: 'ia_home_agent_error',
  idle: 'ia_home_agent_idle',
} as const satisfies Record<HomeAgentState, ConciergeMessageKey>;

export function AgentsTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const action = { label: t('ia_home_agents_open'), href: '/ops?section=operations' };
  return (
    <Tile span="full" testId="home-agents" title={t('ia_home_agents_title')} action={action}>
      <HomeState t={t} home={home} section="agents" onRetry={onRetry}>
        {(data) => {
          const agents = data.agents;
          if (agents.total === 0)
            return (
              <EmptyState
                title={t('ia_home_agents_empty_title')}
                body={t('ia_home_agents_empty_body')}
                action={action}
              />
            );
          const summary = AGENT_STATES.map(
            (state) => `${t(AGENT_KEYS[state])} ${fmtNumber(bcp47, agents[state])}`
          ).join(', ');
          return (
            <div className="kb-home__agents">
              <p className="kb-home__muted">
                {t('ia_home_agents_summary', { total: fmtNumber(bcp47, agents.total) })}
              </p>
              <div
                className="kb-home__stack"
                role="img"
                aria-label={t('ia_home_agents_bar_label', { summary })}
              >
                {AGENT_STATES.filter((state) => agents[state] > 0).map((state) => (
                  <span
                    key={state}
                    className="kb-home__stack-part"
                    data-state={state}
                    style={{ flexGrow: agents[state] }}
                  />
                ))}
              </div>
              <ul className="kb-home__legend">
                {AGENT_STATES.map((state) => (
                  <li key={state} data-state={state} data-zero={agents[state] === 0 || undefined}>
                    <span className="kb-home__swatch" aria-hidden="true" />
                    <span>{t(AGENT_KEYS[state])}</span>
                    <strong>{fmtNumber(bcp47, agents[state])}</strong>
                  </li>
                ))}
              </ul>
              {agents.unassignedItems > 0 ? (
                <Link className="kb-home__note" href="/work?tab=items">
                  {t('ia_home_agents_unassigned', {
                    count: fmtNumber(bcp47, agents.unassignedItems),
                  })}
                </Link>
              ) : null}
            </div>
          );
        }}
      </HomeState>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 4. Missions — open by state, 7-day throughput, top 3 stopped
// ---------------------------------------------------------------------------

const MISSION_STATES: MissionOpenState[] = ['active', 'planned', 'paused', 'failed'];
const MISSION_KEYS = {
  active: 'ia_home_mission_active',
  planned: 'ia_home_mission_planned',
  paused: 'ia_home_mission_paused',
  failed: 'ia_home_mission_failed',
} as const satisfies Record<MissionOpenState, ConciergeMessageKey>;

export function MissionsTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const action = { label: t('ia_home_missions_open'), href: workHref() };
  return (
    <Tile span="half" testId="home-missions" title={t('ia_home_missions_title')} action={action}>
      <HomeState t={t} home={home} section="missions" onRetry={onRetry}>
        {(data) => {
          const missions = data.missions;
          const openTotal = MISSION_STATES.reduce((sum, state) => sum + missions.open[state], 0);
          if (
            openTotal === 0 &&
            missions.throughputTotal === 0 &&
            missions.throughputPrevious === 0
          )
            return (
              <EmptyState
                title={t('ia_home_missions_empty_title')}
                body={t('ia_home_missions_empty_body')}
                action={action}
              />
            );
          const delta = missions.throughputTotal - missions.throughputPrevious;
          return (
            <div className="kb-home__missions">
              <BarRows
                label={t('ia_home_missions_open_label')}
                rows={MISSION_STATES.map((state) => ({
                  key: state,
                  label: t(MISSION_KEYS[state]),
                  value: missions.open[state],
                  valueText: fmtNumber(bcp47, missions.open[state]),
                  href: workHref(state),
                }))}
              />
              <div className="kb-home__trend">
                <span className="kb-home__trend-label">{t('ia_home_missions_throughput')}</span>
                <span className="kb-home__trend-value">
                  {fmtNumber(bcp47, missions.throughputTotal)}
                </span>
                <Sparkline
                  points={missions.throughput}
                  label={t('ia_home_missions_throughput_spark')}
                />
                <Delta
                  t={t}
                  delta={{
                    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
                    text: `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${fmtNumber(bcp47, Math.abs(delta))}`,
                  }}
                />
              </div>
              {missions.blocked.length ? (
                <div className="kb-home__blocked">
                  <h3 className="kb-home__subtitle">{t('ia_home_missions_blocked')}</h3>
                  <ul className="kb-home__list">
                    {missions.blocked.map((mission) => (
                      <li key={mission.id}>
                        <Link href={missionHref(mission.id)} className="kb-home__list-row">
                          <span className="kb-home__list-title">
                            {mission.title || t('ia_home_missions_untitled')}
                          </span>
                          <span className="kb-home__muted">
                            {t(MISSION_KEYS[mission.status])}
                            {mission.updatedAt
                              ? ` · ${relativeTime(mission.updatedAt, bcp47)}`
                              : ''}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {missions.blockedTotal > missions.blocked.length ? (
                    <Link className="kb-home__note" href={workHref('paused')}>
                      {t('ia_home_missions_blocked_more', {
                        count: fmtNumber(bcp47, missions.blockedTotal - missions.blocked.length),
                      })}
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        }}
      </HomeState>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 5. Health — failure rate and duration, with the previous 7 days
// ---------------------------------------------------------------------------

export function HealthTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const action = { label: t('ia_home_health_open'), href: '/ops?section=diagnostics' };
  return (
    <Tile span="half" testId="home-health" title={t('ia_home_health_title')} action={action}>
      <HomeState t={t} home={home} section="health" onRetry={onRetry}>
        {(data) => {
          const health = data.health;
          if (health.failureRateCurrent === null && health.durationCurrent === null)
            return (
              <EmptyState
                title={t('ia_home_health_empty_title')}
                body={t('ia_home_health_empty_body')}
                action={{ label: t('ia_home_missions_open'), href: workHref() }}
              />
            );
          const percent = (value: number | null) =>
            value === null ? '—' : `${fmtNumber(bcp47, value * 100, 1)}%`;
          const hours = (value: number | null) =>
            value === null ? '—' : t('ia_home_health_hours', { value: fmtNumber(bcp47, value, 1) });
          return (
            <div className="kb-home__health">
              <div className="kb-home__trend">
                <span className="kb-home__trend-label">{t('ia_home_health_failure')}</span>
                <span className="kb-home__trend-value">{percent(health.failureRateCurrent)}</span>
                <Sparkline
                  points={health.failureRate.map((value) => (value === null ? null : value * 100))}
                  label={t('ia_home_health_failure_spark')}
                />
                <Delta
                  t={t}
                  delta={windowDelta(health.failureRateCurrent, health.failureRatePrevious, 'pt')}
                />
              </div>
              <div className="kb-home__trend">
                <span className="kb-home__trend-label">{t('ia_home_health_duration')}</span>
                <span className="kb-home__trend-value">{hours(health.durationCurrent)}</span>
                <Sparkline
                  points={health.durationHours}
                  label={t('ia_home_health_duration_spark')}
                />
                <Delta
                  t={t}
                  delta={windowDelta(health.durationCurrent, health.durationPrevious, 'h')}
                />
              </div>
            </div>
          );
        }}
      </HomeState>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 6. Organization key results — bars against target
// ---------------------------------------------------------------------------

const KR_STATUS_KEYS = {
  met: 'ia_home_kr_status_met',
  on_track: 'ia_home_kr_status_on_track',
  at_risk: 'ia_home_kr_status_at_risk',
  off_track: 'ia_home_kr_status_off_track',
  unmeasured: 'ia_home_kr_status_unmeasured',
} as const satisfies Record<HomeDashboard['krs']['items'][number]['status'], ConciergeMessageKey>;

export function KeyResultsTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const action = { label: t('ia_home_krs_open'), href: '/org' };
  return (
    <Tile
      span="half"
      testId="home-krs"
      title={t('ia_home_krs_title')}
      description={
        home.state === 'ready' && home.data.krs.organizationName && home.data.krs.items.length
          ? t('ia_home_krs_of', { organization: home.data.krs.organizationName })
          : undefined
      }
      action={action}
    >
      <HomeState t={t} home={home} section="krs" onRetry={onRetry}>
        {(data) => {
          if (data.krs.state === 'no_organization')
            return (
              <EmptyState
                title={t('ia_home_krs_none_title')}
                body={t('ia_home_krs_none_body')}
                action={action}
              />
            );
          if (data.krs.state === 'no_objectives')
            return (
              <EmptyState
                title={t('ia_home_krs_empty_title')}
                body={t('ia_home_krs_empty_body')}
                action={action}
              />
            );
          return (
            <ul className="kb-home__krs">
              {data.krs.items.map((kr, index) => {
                const progress =
                  kr.percent === undefined
                    ? t('ia_home_kr_unmeasured')
                    : t('ia_home_kr_progress', { percent: kr.percent });
                const value =
                  kr.value !== undefined
                    ? `${t('ia_home_kr_value', {
                        value: fmtNumber(bcp47, kr.value, 2),
                        target: fmtNumber(bcp47, kr.target, 2),
                      })}${kr.unit ? ` ${kr.unit}` : ''}`
                    : '';
                return (
                  <li key={`${kr.title}-${index}`} className="kb-home__kr" data-status={kr.status}>
                    <div className="kb-home__kr-head">
                      <span className="kb-home__kr-title">{kr.title}</span>
                      <span className="kb-home__kr-status">{t(KR_STATUS_KEYS[kr.status])}</span>
                    </div>
                    <span
                      className="kb-home__bar-track kb-home__bar-track--target"
                      role="img"
                      aria-label={t('ia_home_kr_bar_label', { title: kr.title, progress })}
                    >
                      <span
                        className="kb-home__bar-fill"
                        style={
                          {
                            '--kb-home-bar': `${Math.min(100, kr.percent ?? 0)}%`,
                          } as React.CSSProperties
                        }
                      />
                    </span>
                    <span className="kb-home__muted">
                      {kr.percent === undefined
                        ? t('ia_home_kr_target', {
                            target: `${fmtNumber(bcp47, kr.target, 2)}${kr.unit ? ` ${kr.unit}` : ''}`,
                          })
                        : `${progress}${value ? ` · ${value}` : ''}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </HomeState>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 7. Cost against budget
// ---------------------------------------------------------------------------

export function CostTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const setBudget = {
    label: t('ia_home_cost_set_budget'),
    href: settingsHref(`#${SETUP_CHECKLIST_ANCHORS.budget}`),
  };
  return (
    <Tile
      span="half"
      testId="home-cost"
      title={t('ia_home_cost_title')}
      action={{ label: t('ia_home_agents_open'), href: '/ops?section=operations' }}
    >
      <HomeState t={t} home={home} section="cost" onRetry={onRetry}>
        {(data) => {
          const cost = data.cost;
          if (!cost || (cost.totalUsd === 0 && !cost.budgetUsd))
            return (
              <EmptyState
                title={t('ia_home_cost_empty_title')}
                body={t('ia_home_cost_empty_body')}
                action={setBudget}
              />
            );
          const spent = fmtUsd(bcp47, cost.totalUsd);
          if (!cost.budgetUsd)
            return (
              <div className="kb-home__cost">
                <span className="kb-home__trend-label">{t('ia_home_cost_spent')}</span>
                <span className="kb-home__trend-value">{spent}</span>
                <p className="kb-home__muted">{t('ia_home_cost_no_budget')}</p>
                {!cost.complete ? (
                  <p className="kb-home__muted">{t('ia_home_cost_partial')}</p>
                ) : null}
                <div>
                  <Button label={setBudget.label} variant="secondary" href={setBudget.href} />
                </div>
              </div>
            );
          const budget = fmtUsd(bcp47, cost.budgetUsd);
          const scale = Math.max(cost.budgetUsd, cost.totalUsd);
          const summary = t('ia_home_cost_of_budget', { spent, budget });
          return (
            <div className="kb-home__cost">
              <span className="kb-home__trend-label">{t('ia_home_cost_spent')}</span>
              <span className="kb-home__trend-value">{summary}</span>
              <span
                className="kb-home__bar-track kb-home__bar-track--budget"
                role="img"
                aria-label={t('ia_home_cost_bar_label', { summary })}
                style={
                  {
                    '--kb-home-budget': `${(cost.budgetUsd / scale) * 100}%`,
                  } as React.CSSProperties
                }
              >
                <span
                  className="kb-home__bar-fill"
                  data-over={cost.overBudget || undefined}
                  style={
                    {
                      '--kb-home-bar': `${barPercent(cost.totalUsd, scale)}%`,
                    } as React.CSSProperties
                  }
                />
              </span>
              <span className="kb-home__muted">
                {cost.overBudget
                  ? t('ia_home_cost_over', {
                      amount: fmtUsd(bcp47, cost.totalUsd - cost.budgetUsd),
                    })
                  : t('ia_home_cost_remaining', {
                      amount: fmtUsd(bcp47, Math.max(0, cost.budgetUsd - cost.totalUsd)),
                    })}
              </span>
              {!cost.complete ? (
                <p className="kb-home__muted">{t('ia_home_cost_partial')}</p>
              ) : null}
            </div>
          );
        }}
      </HomeState>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// 8. Recent deliverables
// ---------------------------------------------------------------------------

export function DeliverablesTile({ t, home, onRetry, bcp47 = 'en' }: TileProps) {
  const action = { label: t('ia_home_deliverables_open'), href: '/library' };
  return (
    <Tile
      span="full"
      testId="home-deliverables"
      title={t('ia_home_deliverables_title')}
      action={action}
    >
      <HomeState t={t} home={home} section="deliverables" onRetry={onRetry}>
        {(data) =>
          data.deliverables.length === 0 ? (
            <EmptyState
              title={t('ia_home_deliverables_empty_title')}
              body={t('ia_home_deliverables_empty_body')}
              action={action}
            />
          ) : (
            <ul className="kb-home__list">
              {data.deliverables.map((item) => (
                <li key={item.id}>
                  <Link href="/library" className="kb-home__list-row">
                    <span className="kb-home__list-title">
                      {item.title ||
                        t('ia_home_deliverables_dated', {
                          date: new Date(item.updatedAt).toLocaleDateString(bcp47, {
                            month: 'long',
                            day: 'numeric',
                          }),
                        })}
                    </span>
                    <span className="kb-home__muted">
                      {item.missionTitle
                        ? `${t('ia_home_deliverables_from', { mission: item.missionTitle })} · `
                        : ''}
                      {relativeTime(item.updatedAt, bcp47)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </HomeState>
    </Tile>
  );
}
