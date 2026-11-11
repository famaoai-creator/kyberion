import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import {
  composeMissionTeamPlan,
  writeMissionTeamPlan,
} from '@agent/core/mission/mission-team-plan-composer';
import {
  composeMissionTeamBrief,
  writeMissionTeamBrief,
} from '@agent/core/mission/mission-team-brief-composer';
import { loadOrganizationProfile } from '@agent/core/organization/organization-profile';
import { initializeMissionTeamBindings } from '@agent/core/mission/mission-team-binding';
import { resolveMissionDir, tryResolveOwnerScope } from '@agent/core/owner-scope';
import { loadStateAtPath } from '@agent/core/mission/mission-state';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeLstat } from '@agent/core/secure-io';
import { withOrganizationContext } from './refactor/organization-context.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export const MISSION_TEAM_COMPOSITION_USAGE =
  'Usage: pnpm mission:compose-team --mission-id <id> [--request <text>] [--org-role <role>] [--write]';

/**
 * Writes the team plan as the mission controller. The mission's Org Role is
 * descriptive team metadata and is never copied into the execution identity
 * (concept model v2 D5): the write runs with whatever persona the caller
 * already has, and a mission-bound process without one is pinned to `worker`
 * by the authority resolver.
 */
function withMissionWriteContext<T>(fn: () => T): T {
  const previousRole = getRegisteredEnvText('MISSION_ROLE');

  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'mission_controller');
  }

  try {
    return fn();
  } finally {
    setRegisteredEnv('MISSION_ROLE', previousRole);
  }
}

/**
 * `--org-role`, or the pre-S4 `--persona` for one release (with a diagnostic
 * warning) when `--org-role` is absent. When both are given `--org-role` wins.
 */
export function orgRoleArgument(orgRole: unknown, legacyPersona: unknown): string | undefined {
  if (orgRole !== undefined) return orgRole ? String(orgRole) : undefined;
  if (!legacyPersona) return undefined;
  logger.warn(
    '--persona is retired — read once more as --org-role because --org-role is not given; it stops being read next release | next: pass --org-role <role> | evidence: docs/developer/improvement-plans-2026-11/SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md (S4)'
  );
  return String(legacyPersona);
}

export async function main(args: string[] = []): Promise<unknown> {
  if (args.includes('--help') || args.includes('-h')) {
    return { status: 'help', usage: MISSION_TEAM_COMPOSITION_USAGE };
  }

  const argv = await createStandardYargs(['node', 'compose_mission_team', ...args])
    .option('mission-id', { type: 'string', demandOption: true })
    .option('mission-type', { type: 'string' })
    .option('request', {
      type: 'string',
      description: 'Free-form user request to compile team composition brief',
    })
    .option('intent-id', { type: 'string' })
    .option('task-type', { type: 'string' })
    .option('shape', { type: 'string' })
    .option('execution-shape', {
      type: 'string',
      choices: ['direct_reply', 'task_session', 'mission', 'project_bootstrap'] as const,
      default: 'mission',
    })
    .option('artifacts', {
      type: 'string',
      description: 'Comma-separated artifact paths used as evidence for classification',
    })
    .option('signals', {
      type: 'string',
      description: 'Comma-separated progress signals used for stage detection',
    })
    .option('org-role', {
      type: 'string',
      description: "The mission's Org Role (default: the mission state's org_role)",
    })
    .option('persona', {
      type: 'string',
      deprecated: 'use --org-role',
      description: 'Deprecated alias of --org-role, accepted for one release',
    })
    .option('organization-id', {
      type: 'string',
      description: 'Explicit organization slug used to resolve organization defaults and catalogs',
    })
    .option('tenant-slug', {
      type: 'string',
      description: 'Explicit tenant slug used for participant security scope',
    })
    .option('provider', {
      type: 'string',
      description: 'Preferred provider for all team roles (agy, claude, codex, copilot, ...)',
    })
    .option('model', {
      type: 'string',
      description: 'Optional model ID passed with the selected team provider',
    })
    .option('write', { type: 'boolean', default: false })
    .parse();

  const missionId = String(argv['mission-id']).toUpperCase();
  // The mission's own location (all tiers/tenants, independent of KYBERION_TENANT).
  const missionPath = tryResolveOwnerScope({ kind: 'mission', id: missionId })?.dir ?? null;

  let tier = String(argv.tier || 'public') as 'personal' | 'confidential' | 'public';
  let orgRole = orgRoleArgument(argv['org-role'], argv.persona);
  let missionTenantSlug: string | undefined;

  if (missionPath) {
    const missionStatePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'));
    if (!safeLstat(missionStatePath).isFile()) {
      throw new Error(`Mission state must be a regular file: ${missionStatePath}`);
    }
    const state = loadStateAtPath(missionStatePath);
    if (!state) {
      throw new Error(`Mission state is invalid or unreadable: ${missionStatePath}`);
    }
    tier = state.tier;
    orgRole = orgRole || state.org_role;
    missionTenantSlug = state.tenant_slug;
  }

  const artifactPaths = String(argv.artifacts || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const progressSignals = String(argv.signals || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const missionTypeArg = argv['mission-type'] ? String(argv['mission-type']) : undefined;
  const request = argv.request ? String(argv.request) : '';
  const organizationId = argv['organization-id'] ? String(argv['organization-id']) : undefined;
  if (argv.model && !argv.provider) {
    throw new Error('[TEAM_PROVIDER_REQUIRED] --model requires --provider.');
  }
  const tenantSlug =
    missionTenantSlug || (argv['tenant-slug'] ? String(argv['tenant-slug']) : undefined);

  const { plan, brief } = withOrganizationContext(organizationId, () => {
    const organizationProfile = loadOrganizationProfile();
    const nextPlan = composeMissionTeamPlan({
      missionId,
      missionType: missionTypeArg,
      intentId: argv['intent-id'] ? String(argv['intent-id']) : undefined,
      taskType: argv['task-type'] ? String(argv['task-type']) : undefined,
      shape: argv.shape ? String(argv.shape) : undefined,
      utterance: request || undefined,
      artifactPaths,
      progressSignals,
      tier,
      orgRole,
      tenantSlug,
      organizationProfile,
      ...(argv.provider
        ? {
            providerPreference: {
              provider: String(argv.provider),
              ...(argv.model ? { modelId: String(argv.model) } : {}),
            },
          }
        : {}),
    });

    const nextBrief = request
      ? composeMissionTeamBrief({
          missionId,
          missionType: missionTypeArg,
          request,
          intentId: argv['intent-id'] ? String(argv['intent-id']) : undefined,
          taskType: argv['task-type'] ? String(argv['task-type']) : undefined,
          shape: argv.shape ? String(argv.shape) : undefined,
          artifactPaths,
          progressSignals,
          tier,
          orgRole,
          tenantSlug,
          organizationProfile,
          executionShape: argv['execution-shape'] as
            'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap',
        })
      : null;
    return { plan: nextPlan, brief: nextBrief };
  });

  if (argv.write) {
    // Writing a team plan needs an existing mission; an unknown one fails closed.
    const targetDir = missionPath || resolveMissionDir(missionId);
    withMissionWriteContext(() => {
      writeMissionTeamPlan(targetDir, plan);
      initializeMissionTeamBindings(targetDir, plan);
      if (brief) writeMissionTeamBrief(targetDir, brief);
    });
  }

  return brief || plan;
}

export const runComposeMissionTeam = defineScript({
  name: 'mission:compose-team',
  flags: ['json'],
  run: async ({ argv, print }) => {
    const result = await main(argv);
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'compose_mission_team.ts') ||
  isDirectScript(import.meta.url, 'compose_mission_team.js')
)
  void runComposeMissionTeam();
