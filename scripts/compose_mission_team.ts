import * as path from 'node:path';
import {
  createStandardYargs,
  composeMissionTeamPlan,
  composeMissionTeamBrief,
  findMissionPath,
  initializeMissionTeamBindings,
  missionDir,
  writeMissionTeamPlan,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

function withMissionWriteContext<T>(assignedPersona: string | undefined, fn: () => T): T {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = process.env.KYBERION_PERSONA;

  process.env.MISSION_ROLE = process.env.MISSION_ROLE || 'mission_controller';
  if (!process.env.KYBERION_PERSONA && assignedPersona) {
    process.env.KYBERION_PERSONA = assignedPersona;
  }

  try {
    return fn();
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = previousPersona;
  }
}

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
    const state = readJsonFile<{ tier?: typeof tier; assigned_persona?: string }>(
      path.join(missionPath, 'mission-state.json'),
    );
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
    withMissionWriteContext(assignedPersona, () => {
      writeMissionTeamPlan(targetDir, plan);
      initializeMissionTeamBindings(targetDir, plan);
    });
  }

  console.log(JSON.stringify(brief || plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
