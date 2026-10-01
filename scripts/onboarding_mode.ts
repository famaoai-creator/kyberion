import { currentProcessArgv } from './lib/harness.js';
import type { CliGuardSpec } from './lib/cli-guard.js';

/** CU-01: wizard flags; `--help` / typos exit before the wizard opens a prompt or writes state. */
export const ONBOARD_CLI: CliGuardSpec = {
  command: 'pnpm onboard',
  manifestId: 'script.onboard',
  subcommands: ['apply', 'reset', 'company'],
  options: [
    { flag: '--express' },
    { flag: '--menu' },
    { flag: '--reconfig' },
    { flag: '--services-only' },
    { flag: '--service', value: '<service-id>' },
    { flag: '--json' },
    { flag: '--dry-run' },
    { flag: '--quiet' },
  ],
};

export function isExpressOnboarding(argv: readonly string[] = currentProcessArgv()): boolean {
  return argv.includes('--express');
}

export function shouldRefuseNonInteractiveOnboarding(input: {
  interactive: boolean;
  express: boolean;
  allowDefaults?: string;
}): boolean {
  return !input.interactive && !input.express && input.allowDefaults !== '1';
}
