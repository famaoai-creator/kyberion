import { logger, pathResolver } from '@agent/core';
import { spawn } from 'node:child_process';

const DEFAULT_INTERVAL_MS = Number(process.env.KYBERION_GENERATION_SCHEDULE_INTERVAL_MS || 60_000);
const ROOT_DIR = pathResolver.rootDir();
const SCHEDULE_TICK_ENTRY = pathResolver.rootResolve('dist/scripts/run_generation_schedule.js');

async function main() {
  while (true) {
    const child = spawn(
      process.execPath,
      [SCHEDULE_TICK_ENTRY, '--action', 'tick'],
      {
        cwd: ROOT_DIR,
        env: process.env,
        stdio: 'inherit',
      },
    );

    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`generation schedule daemon tick failed with exit code ${code}`));
      });
      child.on('error', reject);
    });

    await new Promise((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
  }
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
