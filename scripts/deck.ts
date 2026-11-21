/**
 * Kyberion Mission Deck — production entry.
 *
 * Conversation-centric multi-agent TUI (Ink): attention rail (decisions,
 * reviews, blocked, running), conversation with inline decision cards and
 * intent preview, live herdr agent tiles with peek / reply / attach.
 * Implementation lives in presence/displays/mission-deck (@presence/mission-deck).
 */
import { createStandardYargs } from '@agent/core/cli-utils';
import { runDeck } from '@presence/mission-deck';
import { setRegisteredEnv } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

// Same base role as the terminal HUD: personal-tier mission reads need it;
// every write still goes through its governed owner.
setRegisteredEnv('KYBERION_BASE_ROLE', 'sovereign');

export async function main(args: string[] = []): Promise<void> {
  const options = await createStandardYargs(['node', 'deck', ...args])
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('view', {
      type: 'string',
      describe: 'Initial view: conversation | missions | terminals',
    })
    .option('inline', { type: 'boolean', default: false, describe: 'Run data loaders in-process' })
    .strict()
    .parse(args);
  await runDeck({ once: options.once, view: options.view, inline: options.inline });
}

export const runDeckScript = defineScript({
  name: 'deck',
  flags: [],
  run: async ({ argv }) => main(argv),
});

if (isDirectScript(import.meta.url, 'deck.ts') || isDirectScript(import.meta.url, 'deck.js'))
  void runDeckScript();
