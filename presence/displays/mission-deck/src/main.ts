import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from '@agent/core/script-harness';
import { runDeck } from './index.js';

export async function main(args: string[] = []): Promise<void> {
  const argv = await createStandardYargs(['node', 'mission-deck', ...args])
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('view', {
      type: 'string',
      describe: 'Initial view: conversation | missions | terminals',
    })
    .option('inline', { type: 'boolean', default: false, describe: 'Run data loaders in-process' })
    .strict()
    .parse();
  await runDeck({ once: argv.once, view: argv.view, inline: argv.inline });
}

const runMissionDeck = defineScript({
  name: 'mission-deck',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'presence/displays/mission-deck/src/main.ts') ||
  isDirectScript(import.meta.url, 'presence/displays/mission-deck/src/main.js')
)
  void runMissionDeck();
