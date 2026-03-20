import * as path from 'node:path';
import {
  createStandardYargs,
  composeMissionTeamPlan,
  findMissionPath,
  missionDir,
  safeReadFile,
  writeMissionTeamPlan,
} from '@agent/core';

async function main() {
  const argv = await createStandardYargs()
    .option('mission-id', { type: 'string', demandOption: true })
    .option('mission-type', { type: 'string', default: 'development' })
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

  const plan = composeMissionTeamPlan({
    missionId,
    missionType: String(argv['mission-type']),
    tier,
    assignedPersona,
  });

  if (argv.write) {
    const targetDir = missionPath || missionDir(missionId, tier);
    writeMissionTeamPlan(targetDir, plan);
  }

  console.log(JSON.stringify(plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
