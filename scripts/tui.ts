/**
 * Kyberion Terminal HUD — production entry.
 *
 * Full-screen interactive TUI (Ink) covering missions, work items, schedules,
 * background processes, stats, agent coordination, profile, settings, and an
 * operator input bar (text + voice). Implementation lives in
 * presence/displays/terminal-hud (@presence/terminal-hud).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandardYargs } from '@agent/core/cli-utils';
import { runTui } from '@presence/terminal-hud';

// Keep the interactive entrypoint in this process so stdin/stdout retain the
// terminal's raw-mode capability. The old run_with_env wrapper used a
// synchronous captured child process, which is correct for snapshots but not
// for an Ink application.
process.env.KYBERION_PERSONA = 'sovereign';
const SOURCE_ENTRY = '../presence/displays/terminal-hud/src/main.js';

export async function main(): Promise<void> {
  const devMode = process.argv.includes('--dev');
  if (devMode) {
    process.argv = process.argv.filter((arg) => arg !== '--dev');
    await import(SOURCE_ENTRY);
    return;
  }

  const argv = await createStandardYargs()
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('panel', { type: 'string', describe: 'Focus a single panel in --once mode' })
    .strict()
    .parse();

  await runTui({ once: argv.once, panel: argv.panel });
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isMainModule) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tui failed: ${message}\n`);
    process.exit(1);
  });
}
