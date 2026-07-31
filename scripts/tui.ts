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

export async function main(): Promise<void> {
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
