import {
  checkAllReasoningBackendAuth,
  checkReasoningBackendAuth,
} from '@agent/core/reasoning-auth-preflight';
import { defineScript, isDirectScript } from './lib/harness.js';

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export const runReasoningAuthCheck = defineScript({
  name: 'reasoning:auth-check',
  flags: [],
  run(context) {
    const backend = option(context.argv, '--backend');
    const results = backend ? [checkReasoningBackendAuth(backend)] : checkAllReasoningBackendAuth();

    if (hasFlag(context.argv, '--json')) {
      context.print({ results });
    } else {
      for (const result of results) {
        const missing = result.missing_environment.length
          ? ` missing=${result.missing_environment.join(',')}`
          : '';
        console.log(`${result.mode}: ${result.status}${missing} — ${result.note}`);
      }
    }

    if (results.some((result) => result.status === 'missing')) {
      throw new Error('one or more reasoning backends are missing required configuration');
    }
  },
});

if (
  isDirectScript(import.meta.url, 'reasoning_auth_check.ts') ||
  isDirectScript(import.meta.url, 'reasoning_auth_check.js')
)
  void runReasoningAuthCheck();
