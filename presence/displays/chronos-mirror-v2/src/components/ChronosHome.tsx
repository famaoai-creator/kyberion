'use client';

import * as React from 'react';
import type { KbActionRef, KbNextActionProps } from '@agent/core/a2ui-catalog';
import { Callout, NextAction, Section, Skeleton } from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText } from '../lib/ux-vocabulary';
import type { ClientOperatorHomeSummary } from '../lib/operator-home-response';
import { CHRONOS_ACTIONS, type ConsoleContentSection } from '../app/chronos-page-config';
import {
  ChronosMissionTable,
  buildMissionRows,
  dedupeOfficeAgents,
  useChronosOffice,
  type OfficeRoom,
} from './ChronosOffice';

export type HomeCounter = {
  key: string;
  value: number;
  label: string;
  targetId: string;
  tone: 'info' | 'neutral' | 'alert';
};

type Translate = (key: string) => string;

/** Agents whose runtime needs a look: blocked / offline, or provider pressure. */
export function countRuntimeIssues(rooms: OfficeRoom[]): number {
  const agents = dedupeOfficeAgents(rooms.flatMap((room) => room.agents));
  return agents.filter(
    (agent) =>
      agent.status === 'blocked' ||
      agent.status === 'offline' ||
      Boolean(agent.pressure && agent.pressure.severity !== 'normal')
  ).length;
}

function openSection(label: string, section: ConsoleContentSection): KbActionRef {
  return { label, action: { id: CHRONOS_ACTIONS.openSection, payload: { section } } };
}

function openScenario(label: string, targetId: string): KbActionRef {
  return { label, action: { id: CHRONOS_ACTIONS.openScenario, payload: { targetId } } };
}

/**
 * The one thing to do next, computed from real control-plane data: paused or
 * failed missions → pending approvals → runtime issues → planned missions →
 * deliverables waiting for review; otherwise a calm empty state.
 */
export function buildChronosNextAction(input: {
  summary: ClientOperatorHomeSummary;
  runtimeIssues: number;
  t: Translate;
  message: (key: string, params: Record<string, number>) => string;
}): KbNextActionProps {
  const { summary, runtimeIssues, t, message } = input;
  const counts = summary.counts;
  const blocked = Number(counts.blockedMissions || 0);
  const approvals = Number(counts.pendingApprovals || 0);
  const planned = summary.plannedMissions?.length || 0;
  const inbox = Number(counts.unreadInbox || 0);
  const eyebrow = t('chronos_cb_do_this_next');
  const open = t('chronos_cb_open');
  const missions = openSection(t('chronos_home_action_clear'), 'missions');

  if (blocked > 0) {
    return {
      eyebrow,
      title: t('chronos_home_action_blocked'),
      reason: message('chronos_home_reason_blocked', { count: blocked }),
      primary: openScenario(open, 'needs-attention'),
      secondary: { ...missions, variant: 'ghost' },
      state: 'ready',
    };
  }
  if (approvals > 0) {
    return {
      eyebrow,
      title: t('chronos_home_action_approvals'),
      reason: message('chronos_home_reason_approvals', { count: approvals }),
      primary: openSection(open, 'approvals'),
      state: 'ready',
    };
  }
  if (runtimeIssues > 0) {
    return {
      eyebrow,
      title: t('chronos_home_action_runtime'),
      reason: message('chronos_home_reason_runtime', { count: runtimeIssues }),
      primary: openSection(open, 'operations'),
      state: 'ready',
    };
  }
  if (planned > 0) {
    return {
      eyebrow,
      title: t('chronos_home_action_planned'),
      reason: message('chronos_home_reason_planned', { count: planned }),
      primary: openScenario(open, 'mission-control-plane'),
      state: 'ready',
    };
  }
  if (inbox > 0) {
    return {
      eyebrow,
      title: t('chronos_home_action_inbox'),
      reason: message('chronos_home_reason_inbox', { count: inbox }),
      primary: openSection(open, 'deliverables'),
      state: 'ready',
    };
  }
  return {
    eyebrow: t('chronos_status_clear'),
    title: t('chronos_home_status_clear'),
    reason: t('chronos_cb_all_clear_detail'),
    secondary: missions,
    state: 'empty',
  };
}

const COUNTER_TONE: Record<HomeCounter['tone'], string> = {
  info: 'info',
  alert: 'warning',
  neutral: 'neutral',
};

/**
 * UI-07 home: NextAction hero (Skeleton while the control plane loads),
 * counters that jump to their queue, the missions-in-motion table sorted by
 * attention, then the mission journey and OS control plane as compact
 * sections (rendered by the shell below this component).
 */
export function ChronosHome({
  tenant,
  summary,
  summaryError,
  counters,
  missionTitles,
  onOpenScenario,
  onOpenMission,
}: {
  tenant: string;
  summary: ClientOperatorHomeSummary | null;
  summaryError: string | null;
  counters: HomeCounter[];
  missionTitles: Readonly<Record<string, string | undefined>>;
  onOpenScenario: (targetId: string) => void;
  onOpenMission: (missionId: string) => void;
}) {
  const locale = useChronosLocale();
  const { office, error: officeError, loading: officeLoading } = useChronosOffice(tenant);
  const rooms = React.useMemo(() => office?.rooms ?? [], [office]);
  const runtimeIssues = React.useMemo(() => countRuntimeIssues(rooms), [rooms]);
  const rows = React.useMemo(
    () => buildMissionRows(rooms, missionTitles, uxText('chronos_office_operator_floor', locale)),
    [rooms, missionTitles, locale]
  );
  const nextAction = React.useMemo(
    () =>
      summary
        ? buildChronosNextAction({
            summary,
            runtimeIssues,
            t: (key) => uxText(key, locale),
            message: (key, params) => uxMessage(key, params, key, locale),
          })
        : null,
    [summary, runtimeIssues, locale]
  );

  return (
    <>
      {summaryError ? (
        <Callout
          tone="danger"
          title={uxText('chronos_home_load_failed', locale)}
          body={summaryError}
        />
      ) : null}
      {nextAction ? (
        <NextAction {...nextAction} />
      ) : summaryError ? null : (
        <Skeleton shape="card" lines={3} label={uxText('chronos_cb_reading_state', locale)} />
      )}

      {counters.length > 0 ? (
        <div className="chronos-counters">
          {counters.map((counter) => (
            <button
              key={counter.key}
              type="button"
              className="chronos-counter"
              data-tone={counter.value > 0 ? COUNTER_TONE[counter.tone] : undefined}
              onClick={() => onOpenScenario(counter.targetId)}
            >
              <span className="chronos-counter__value">{counter.value}</span>
              <span className="chronos-counter__label">{counter.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Section
        title={uxText('chronos_home_missions_title', locale)}
        description={uxText('chronos_home_missions_description', locale)}
      >
        {officeError ? <p className="chronos-scope__error">{officeError}</p> : null}
        {officeLoading && !office ? (
          <Skeleton shape="table" lines={4} />
        ) : (
          <ChronosMissionTable rows={rows} onOpenMission={onOpenMission} />
        )}
      </Section>
    </>
  );
}
