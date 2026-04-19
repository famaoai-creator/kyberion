import * as path from 'node:path';
import {
  composeMissionTeamBrief,
  createStandardYargs,
  composeMissionTeamPlan,
  findMissionPath,
  initializeMissionTeamBindings,
  missionDir,
  safeReadFile,
  writeMissionTeamPlan,
} from '@agent/core';

async function main() {
  const argv = await createStandardYargs()
    .option('mission-id', { type: 'string', demandOption: true })
    .option('mission-type', { type: 'string' })
    .option('request', { type: 'string', description: 'Free-form user request to compile team composition brief' })
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
    .option('write', { type: 'boolean', default: false })
    .parse();

  const missionId = String(argv['mission-id']).toUpperCase();
  const missionPath = findMissionPath(missionId);

  let tier = String(argv.tier || 'public') as 'personal' | 'confidential' | 'public';
  let assignedPersona = argv.persona ? String(argv.persona) : undefined;

  if (missionPath) {
    const state = JSON.parse(
      safeReadFile(path.join(missionPath, 'mission-state.json'), { encoding: 'utf8' }) as string,
    ) as { tier?: typeof tier; assigned_persona?: string };
    tier = state.tier || tier;
    assignedPersona = assignedPersona || state.assigned_persona;
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

  const plan = composeMissionTeamPlan({
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
  });

  const brief = request
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
      executionShape: argv['execution-shape'] as 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap',
    })
    : null;

  if (argv.write) {
    const targetDir = missionPath || missionDir(missionId, tier);
    writeMissionTeamPlan(targetDir, plan);
    initializeMissionTeamBindings(targetDir, plan);
  }

  console.log(JSON.stringify(brief || plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
