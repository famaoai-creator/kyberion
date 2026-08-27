import * as path from 'node:path';
import {
  createStandardYargs,
  composeMissionTeamPlan,
  composeMissionTeamBrief,
  loadOrganizationProfile,
  writeMissionTeamBrief,
  findMissionPath,
  initializeMissionTeamBindings,
  missionDir,
  writeMissionTeamPlan,
} from '@agent/core';
import { getRegisteredEnvText, readJson, setRegisteredEnv } from '@agent/core/foundation';
import { withOrganizationContext } from './refactor/organization-context.js';

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

async function main() {
  const argv = await createStandardYargs()
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
    const state = readJson<{
      tier?: typeof tier;
      tenant_slug?: string;
      assigned_persona?: string;
    }>(path.join(missionPath, 'mission-state.json'));
    tier = state.tier || tier;
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

  console.log(JSON.stringify(brief || plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
