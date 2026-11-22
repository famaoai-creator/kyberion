/**
 * minutes:record mission resolution.
 *
 * A meeting recorded without `--mission` gets its own mission of type
 * `meeting_facilitation` (routed by the workflow catalog onto the
 * meeting-operations template), created through the governed lifecycle
 * facade — never the default `development` template, whose code tasks a
 * meeting never closes. A mission passed with `--mission` is used as is.
 */

import { logger } from '@agent/core/core';
import { activeTenantSlug } from '@agent/core/organization/tenant-registry';
import { t as catalogT } from '@agent/core/t';
import { findMissionPath } from '@agent/core/path-resolver';
import { missionPathOrNull } from '@agent/core/mission-lookup';
import { writeIntentGoalHandoff } from '@agent/core/intent/intent-handoff';
import { withMissionPrerequisiteIdentityProbe } from '@agent/core/mission/mission-prerequisite-identity';
import { inspectMissionPrerequisiteIdentity } from './installed-identity.js';

export const MEETING_MISSION_TYPE = 'meeting_facilitation';

type StartFn = (
  id: string,
  tier: 'personal' | 'confidential' | 'public',
  persona: string,
  tenantId: string,
  missionType: string,
  visionRef: string | undefined,
  relationships: Record<string, unknown>,
  tenantSlug: string | undefined,
  options: { intentGoal?: string }
) => Promise<unknown>;

export interface ResolveMeetingMissionInput {
  /** `--mission`; when set it is returned unchanged (its type is never rewritten). */
  missionId?: string;
  /** `--tenant`; falls back to KYBERION_TENANT. */
  tenantSlug?: string;
  /** `--title`; becomes the mission's intent goal. */
  title?: string;
  now?: Date;
  /** Test seams. */
  start?: StartFn;
  exists?: (missionId: string) => boolean;
}

export interface ResolvedMeetingMission {
  missionId: string;
  created: boolean;
  tier?: 'personal' | 'confidential';
  tenantSlug?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `MSN-MEETING-<YYYYMMDD>-<HHMM>` in local time (one meeting per minute). */
export function defaultMeetingMissionId(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `MSN-MEETING-${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Returns the mission to record into, creating a meeting mission when none was given. */
export async function resolveMeetingMission(
  input: ResolveMeetingMissionInput
): Promise<ResolvedMeetingMission> {
  if (input.missionId) return { missionId: input.missionId.toUpperCase(), created: false };

  const exists = input.exists ?? ((id: string) => missionPathOrNull(findMissionPath, id) !== null);
  const base = defaultMeetingMissionId(input.now);
  let missionId = base;
  for (let suffix = 2; exists(missionId); suffix += 1) {
    if (suffix > 50) throw new Error(`[minutes:record] no free mission id near ${base}`);
    missionId = `${base}-${suffix}`;
  }

  const tenantSlug = input.tenantSlug || activeTenantSlug() || undefined;
  // A tenant meeting is confidential tenant data; without a tenant it stays personal.
  const tier: 'personal' | 'confidential' = tenantSlug ? 'confidential' : 'personal';
  const title = input.title?.trim();
  const intentGoal = title
    ? catalogT('minutes_record:meeting_mission_goal_titled', { title })
    : catalogT('minutes_record:meeting_mission_goal');

  const start: StartFn =
    input.start ??
    (async (...args) => {
      const { missionLifecycleService } =
        await import('@agent/core/mission/mission-lifecycle-service');
      const [id, tier, role, tenantId, missionType, visionRef, relationships, tenantSlug, options] =
        args;
      const goal = options.intentGoal;
      const intentGoal = goal
        ? writeIntentGoalHandoff(id, { source_text: goal, goal: { summary: goal } })
        : undefined;
      return withMissionPrerequisiteIdentityProbe(inspectMissionPrerequisiteIdentity, () =>
        missionLifecycleService.start(
          id,
          tier,
          role,
          tenantId,
          missionType,
          visionRef,
          relationships,
          tenantSlug,
          { intentGoal }
        )
      );
    });
  await start(
    missionId,
    tier,
    'worker',
    'default',
    MEETING_MISSION_TYPE,
    undefined,
    {},
    tenantSlug,
    { intentGoal }
  );
  logger.info(
    `🗂️  meeting mission ${missionId} created (type=${MEETING_MISSION_TYPE}, tier=${tier}${tenantSlug ? `, tenant=${tenantSlug}` : ''})`
  );
  return { missionId, created: true, tier, ...(tenantSlug ? { tenantSlug } : {}) };
}
