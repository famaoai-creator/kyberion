/**
 * Kyberion Terminal HUD — production entry.
 *
 * Full-screen interactive TUI (Ink) covering missions, work items, schedules,
 * background processes, stats, agent coordination, profile, settings, and an
 * operator input bar (text + voice). Implementation lives in
 * presence/displays/terminal-hud (@presence/terminal-hud).
 */
import { createStandardYargs } from '@agent/core/cli-utils';
import { runTui } from '@presence/terminal-hud';
import { setRegisteredEnv } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

// Keep the interactive entrypoint in this process so stdin/stdout retain the
// terminal's raw-mode capability. The old run_with_env wrapper used a
// synchronous captured child process, which is correct for snapshots but not
// for an Ink application.
setRegisteredEnv('KYBERION_PERSONA', 'sovereign');
const SOURCE_ENTRY = '../presence/displays/terminal-hud/src/main.js';

export async function main(args: string[] = []): Promise<void> {
  const devMode = args.includes('--dev');
  if (devMode) {
    process.argv = [
      process.argv[0] || 'node',
      process.argv[1] || 'scripts/tui.ts',
      ...args.filter((arg) => arg !== '--dev'),
    ];
    await import(SOURCE_ENTRY);
    return;
  }

  const options = await createStandardYargs()
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('panel', { type: 'string', describe: 'Focus a single panel in --once mode' })
    .strict()
    .parse(args);

  await runTui({ once: options.once, panel: options.panel });
}

export const runTuiScript = defineScript({
  name: 'tui',
  flags: [],
  run: async ({ argv }) => main(argv),
});

if (isDirectScript(import.meta.url, 'tui.ts') || isDirectScript(import.meta.url, 'tui.js'))
  void runTuiScript();
