import { createStandardYargs } from '@agent/core/cli-utils';
import { runTui } from './index.js';

async function main(): Promise<void> {
  const argv = await createStandardYargs(process.argv)
    .option('once', { type: 'boolean', default: false, describe: 'Render one snapshot and exit' })
    .option('panel', { type: 'string', describe: 'Focus a single panel in --once mode' })
    .strict()
    .parse();

  await runTui({ once: argv.once, panel: argv.panel });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`terminal-hud failed: ${message}\n`);
  process.exitCode = 1;
});
