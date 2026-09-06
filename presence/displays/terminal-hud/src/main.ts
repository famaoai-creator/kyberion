import { createStandardYargs } from '@agent/core/cli-utils';
import { runTui } from './index.js';
import { defineScript, isDirectScript } from '@agent/core/script-harness';

export async function main(args: string[] = []): Promise<void> {
  const argv = await createStandardYargs(['node', 'terminal-hud', ...args])
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('panel', { type: 'string', describe: 'Focus a single panel in --once mode' })
    .strict()
    .parse();

  await runTui({ once: argv.once, panel: argv.panel });
}

const runTerminalHud = defineScript({
  name: 'terminal-hud',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'presence/displays/terminal-hud/src/main.ts') ||
  isDirectScript(import.meta.url, 'presence/displays/terminal-hud/src/main.js')
)
  void runTerminalHud();
