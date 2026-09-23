'use client';

import { Badge, Button, Section } from '@agent/shared-ui';
import { MISSION_CYCLE } from '../lib/operator-console';
import { uxText } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import { humanizeMissionId } from './ChronosOffice';

type MissionJourneySummaryProps = {
  summary: {
    status?: string;
    counts?: Record<string, number>;
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

/**
 * UI-07: the mission journey as a compact `ui:section` — the six-step cycle
 * on one row and the current mission (human title, id in mono). The "what
 * next" answer lives in the home NextAction, so it is not repeated here.
 */
export function MissionJourneySummary({
  summary,
  onOpenMissions,
  onOpenOperations,
}: MissionJourneySummaryProps) {
  const locale = useChronosLocale();
  const currentMission = summary?.activeMissions?.[0];
  const currentStep = resolveCurrentStepIndex(summary?.status);
  const counts = summary?.counts || {};
  const blocked = Number(counts.blockedMissions || 0);
  const currentTitle = currentMission
    ? currentMission.goalSummary?.trim() ||
      (currentMission.missionType === 'product_delivery'
        ? uxText('chronos_mission_type_product_delivery', locale)
        : humanizeMissionId(currentMission.missionId))
    : null;

  return (
    <Section
      title={uxText('chronos_journey_eyebrow', locale)}
      description={uxText('chronos_journey_description', locale)}
    >
      <div className="chronos-header__controls">
        <Badge
          label={`${Number(counts.activeMissions || 0)} ${uxText('chronos_active', locale)}`}
        />
        {blocked > 0 ? (
          <Badge
            tone="warning"
            label={`${blocked} ${uxText('chronos_journey_attention', locale)}`}
          />
        ) : null}
      </div>
      <ol className="chronos-journey">
        {MISSION_CYCLE.map((step, index) => (
          <li
            key={step.labelKey}
            className="chronos-journey__step"
            data-state={
              index === currentStep ? 'current' : index < currentStep ? 'done' : undefined
            }
            aria-current={index === currentStep ? 'step' : undefined}
          >
            <span className="chronos-journey__index" aria-hidden="true">
              {index + 1}
            </span>
            {uxText(step.labelKey, locale)}
          </li>
        ))}
      </ol>
      <div className="chronos-mission-cell">
        <span className="chronos-feed__title">
          {uxText('chronos_journey_current_mission', locale)}
        </span>
        {currentMission && currentTitle ? (
          <>
            <span className="chronos-mission-cell__title">{currentTitle}</span>
            <span className="chronos-mission-cell__id">{currentMission.missionId}</span>
          </>
        ) : (
          <span className="chronos-muted">
            {uxText('chronos_journey_no_active_mission', locale)}
          </span>
        )}
      </div>
      <div className="chronos-header__controls">
        <Button label={uxText('chronos_journey_open_mission', locale)} onClick={onOpenMissions} />
        <Button
          label={uxText('chronos_journey_view_agents', locale)}
          variant="ghost"
          onClick={onOpenOperations}
        />
      </div>
    </Section>
  );
}
