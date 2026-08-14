'use client';

import { ArrowRight, CircleAlert, ListChecks } from 'lucide-react';
import { MISSION_CYCLE } from '../lib/operator-console';
import { uxMessage, uxText } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';

type MissionJourneySummaryProps = {
  summary: {
    status?: string;
    statusLabel?: string;
    statusDetail?: string;
    nextAction?: { title?: string; reason?: string };
    counts?: Record<string, number>;
    plannedMissions?: unknown[];
    activeMissions?: Array<{
      missionId: string;
      status?: string;
      goalSummary?: string;
      missionType?: string;
      updatedAt?: string;
    }>;
  } | null;
  onOpenMissions: () => void;
  onOpenOperations: () => void;
};

function resolveCurrentStepIndex(status: string | undefined): number {
  if (status === 'completed' || status === 'archived') return 5;
  if (status === 'review' || status === 'distilling') return 4;
  if (status === 'blocked' || status === 'failed' || status === 'paused') return 2;
  if (status === 'planning' || status === 'pending') return 1;
  return 2;
}

function resolveMissionTypeLabel(
  missionType: string | undefined,
  locale: Parameters<typeof uxText>[1]
): string {
  if (missionType === 'product_delivery') {
    return uxText('chronos_mission_type_product_delivery', locale);
  }
  return missionType || uxText('chronos_journey_no_active_mission', locale);
}

export function MissionJourneySummary({
  summary,
  onOpenMissions,
  onOpenOperations,
}: MissionJourneySummaryProps) {
  const locale = useChronosLocale();
  const currentMission = summary?.activeMissions?.[0];
  const currentStep = resolveCurrentStepIndex(summary?.status);
  const counts = summary?.counts || {};
  const needsAttention = Number(counts.blockedMissions || 0) > 0;
  const blocked = Number(counts.blockedMissions || 0);
  const pendingApprovals = Number(counts.pendingApprovals || 0);
  const planned = summary?.plannedMissions?.length || 0;
  const unreadInbox = Number(counts.unreadInbox || 0);
  const nextAction =
    blocked > 0
      ? uxText('chronos_home_action_blocked', locale)
      : pendingApprovals > 0
        ? uxText('chronos_home_action_approvals', locale)
        : planned > 0
          ? uxText('chronos_home_action_planned', locale)
          : unreadInbox > 0
            ? uxText('chronos_home_action_inbox', locale)
            : uxText('chronos_home_action_clear', locale);
  const nextActionReason =
    blocked > 0
      ? uxMessage('chronos_home_reason_blocked', { count: blocked }, '', locale)
      : pendingApprovals > 0
        ? uxMessage('chronos_home_reason_approvals', { count: pendingApprovals }, '', locale)
        : planned > 0
          ? uxMessage('chronos_home_reason_planned', { count: planned }, '', locale)
          : unreadInbox > 0
            ? uxMessage('chronos_home_reason_inbox', { count: unreadInbox }, '', locale)
            : uxText('chronos_home_action_clear_detail', locale);

  return (
    <section className="rounded-[28px] border kb-border-accent kb-surface-accent p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_journey_eyebrow', locale)}
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight kb-text-primary md:text-2xl">
            {uxText('chronos_journey_title', locale)}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 kb-text-secondary">
            {uxText('chronos_journey_description', locale)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em]">
          <span className="rounded-full border kb-border-subtle kb-surface-raised px-3 py-1.5 kb-text-secondary">
            {Number(counts.activeMissions || 0)} {uxText('chronos_active', locale)}
          </span>
          {needsAttention ? (
            <span className="flex items-center gap-1 rounded-full border kb-status-warning-border kb-status-warning-surface px-3 py-1.5 kb-status-warning">
              <CircleAlert size={12} />
              {Number(counts.blockedMissions || 0)} {uxText('chronos_journey_attention', locale)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-2 md:grid-cols-6">
        {MISSION_CYCLE.map((step, index) => {
          const isCurrent = index === currentStep;
          const isComplete = index < currentStep;
          return (
            <div
              key={step.labelKey}
              className={`rounded-2xl border px-3 py-3 ${
                isCurrent
                  ? 'kb-border-accent kb-surface-raised'
                  : isComplete
                    ? 'kb-border-subtle kb-surface-raised'
                    : 'kb-border-subtle kb-surface-sunken'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                    isCurrent
                      ? 'kb-border-accent kb-surface-accent kb-text-accent'
                      : isComplete
                        ? 'kb-border-subtle kb-surface-raised kb-text-secondary'
                        : 'kb-border-subtle kb-surface-sunken kb-text-muted'
                  }`}
                >
                  {index + 1}
                </span>
                <span
                  className={`text-[10px] font-bold uppercase tracking-[0.14em] ${isCurrent ? 'kb-text-accent' : 'kb-text-secondary'}`}
                >
                  {uxText(step.labelKey, locale)}
                </span>
              </div>
              {isCurrent ? (
                <div className="mt-2 text-[10px] leading-5 kb-text-secondary">
                  {uxText('chronos_journey_current_location', locale)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1.1fr,1fr]">
        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] kb-text-muted">
            <ListChecks size={13} />
            {uxText('chronos_journey_current_mission', locale)}
          </div>
          <div className="mt-2 text-sm font-semibold kb-text-primary">
            {currentMission?.missionId || uxText('chronos_journey_no_mission', locale)}
          </div>
          <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
            {currentMission?.goalSummary ||
              resolveMissionTypeLabel(currentMission?.missionType, locale) ||
              uxText('chronos_journey_no_active_mission', locale)}
          </div>
        </div>
        <div className="rounded-2xl border kb-border-accent kb-surface-raised p-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] kb-text-accent">
            {uxText('chronos_journey_next_action', locale)}
          </div>
          <div className="mt-2 text-sm font-semibold kb-text-primary">{nextAction}</div>
          <div className="mt-1 text-[11px] leading-5 kb-text-secondary">{nextActionReason}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpenMissions}
          className="inline-flex items-center gap-2 rounded-xl border kb-border-accent kb-surface-raised px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-accent"
        >
          {uxText('chronos_journey_open_mission', locale)} <ArrowRight size={13} />
        </button>
        <button
          type="button"
          onClick={onOpenOperations}
          className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary"
        >
          {uxText('chronos_journey_view_agents', locale)}
        </button>
      </div>
    </section>
  );
}
