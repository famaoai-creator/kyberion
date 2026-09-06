import * as authority from '@agent/core/authority';
import { createStandardYargs } from '@agent/core/cli-utils';
import { recordModelRoleFeedback } from '@agent/core/model-performance-index';
import { withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(args: string[] = []) {
  const argv = await createStandardYargs(['node', 'model_feedback', ...args])
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
  return feedback;
}

export const runModelFeedback = defineScript({
  name: 'model-feedback',
  flags: [],
  run: async ({ argv, print }) => {
    const feedback = await main(argv);
    print(feedback);
    return feedback;
  },
});

if (
  isDirectScript(import.meta.url, 'model_feedback.ts') ||
  isDirectScript(import.meta.url, 'model_feedback.js')
)
  void runModelFeedback();
