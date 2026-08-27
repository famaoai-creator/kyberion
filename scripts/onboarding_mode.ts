import { currentProcessArgv } from './lib/harness.js';

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
