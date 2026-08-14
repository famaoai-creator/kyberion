import {
  authority,
  createStandardYargs,
  recordModelRoleFeedback,
  withExecutionContext,
} from '@agent/core';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('model-id', { type: 'string', demandOption: true })
    .option('team-role', { type: 'string', demandOption: true })
    .option('rating', { type: 'number', demandOption: true })
    .option('mission-id', { type: 'string' })
    .option('task-id', { type: 'string' })
    .option('comment', { type: 'string' })
    .option('source', {
      type: 'string',
      choices: ['user', 'operator'] as const,
      default: 'user',
    })
    .strict()
    .parse();

  const source = argv.source as 'user' | 'operator';
  if (
    source === 'operator' &&
    !new Set(['ecosystem_architect', 'mission_controller']).has(authority.resolveRole() || '')
  ) {
    throw new Error(
      'operator feedback requires MISSION_ROLE=mission_controller or ecosystem_architect'
    );
  }

  const feedback = withExecutionContext('surface_runtime', () =>
    recordModelRoleFeedback({
      modelId: String(argv['model-id']),
      teamRole: String(argv['team-role']),
      rating: Number(argv.rating),
      ...(argv['mission-id'] ? { missionId: String(argv['mission-id']) } : {}),
      ...(argv['task-id'] ? { taskId: String(argv['task-id']) } : {}),
      ...(argv.comment ? { comment: String(argv.comment) } : {}),
      source,
    })
  );
  console.log(JSON.stringify(feedback, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
