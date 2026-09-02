import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  composeMissionTeamPlan,
  writeMissionTeamPlan,
} from '@agent/core/mission-team-plan-composer';
import {
  composeMissionTeamBrief,
  writeMissionTeamBrief,
} from '@agent/core/mission-team-brief-composer';
import { loadOrganizationProfile } from '@agent/core/organization-profile';
import { initializeMissionTeamBindings } from '@agent/core/mission-team-binding';
import { findMissionPath, missionDir } from '@agent/core/path-resolver';
import { loadStateAtPath } from '@agent/core/mission-state';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeLstat } from '@agent/core/secure-io';
import { withOrganizationContext } from './refactor/organization-context.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export const MISSION_TEAM_COMPOSITION_USAGE =
  'Usage: pnpm mission:compose-team --mission-id <id> [--request <text>] [--write]';

function withMissionWriteContext<T>(assignedPersona: string | undefined, fn: () => T): T {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = getRegisteredEnvText('KYBERION_PERSONA');

  process.env.MISSION_ROLE = process.env.MISSION_ROLE || 'mission_controller';
  if (!getRegisteredEnvText('KYBERION_PERSONA') && assignedPersona) {
    setRegisteredEnv('KYBERION_PERSONA', assignedPersona);
  }

  try {
    return fn();
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    setRegisteredEnv('KYBERION_PERSONA', previousPersona);
  }
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
    .option('persona', { type: 'string' })
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
  const missionPath = findMissionPath(missionId);

  let tier = String(argv.tier || 'public') as 'personal' | 'confidential' | 'public';
  let assignedPersona = argv.persona ? String(argv.persona) : undefined;
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
    assignedPersona = assignedPersona || state.assigned_persona;
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
      assignedPersona,
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
          assignedPersona,
          tenantSlug,
          organizationProfile,
          executionShape: argv['execution-shape'] as
            'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap',
        })
      : null;
    return { plan: nextPlan, brief: nextBrief };
  });

  if (argv.write) {
    const targetDir = missionPath || missionDir(missionId, tier);
    withMissionWriteContext(assignedPersona, () => {
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
