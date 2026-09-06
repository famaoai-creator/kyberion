import {
  checkAllReasoningBackendAuth,
  checkReasoningBackendAuth,
  probeAllReasoningBackendAuth,
  probeReasoningBackendAuth,
  type ReasoningAuthProbeResult,
} from '@agent/core/reasoning-auth-preflight';
import { defineScript, isDirectScript } from './lib/harness.js';

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export const runReasoningAuthCheck = defineScript({
  name: 'reasoning:auth-check',
  flags: ['json', 'quiet'],
  async run(context) {
    const backend = option(context.argv, '--backend');
    const probe = context.argv.includes('--probe');
    const results = probe
      ? backend
        ? [await probeReasoningBackendAuth(backend)]
        : await probeAllReasoningBackendAuth()
      : backend
        ? [checkReasoningBackendAuth(backend)]
        : checkAllReasoningBackendAuth();

    if (context.json) {
      context.print({ results });
    } else {
      context.print(
        results
          .map((result) => {
            const missing = result.missing_environment.length
              ? ` missing=${result.missing_environment.join(',')}`
              : '';
            const probeResult = probe
              ? ` probe=${(result as ReasoningAuthProbeResult).probe.status} — ${(result as ReasoningAuthProbeResult).probe.note}`
              : '';
            return `${result.mode}: ${result.status}${missing} — ${result.note}${probeResult}`;
          })
          .join('\n')
      );
    }

    if (
      results.some(
        (result) =>
          result.status === 'missing' ||
          (probe && (result as ReasoningAuthProbeResult).probe.status === 'failed')
      )
    ) {
      throw new Error(
        probe
          ? 'one or more reasoning backends failed credential/provider verification'
          : 'one or more reasoning backends are missing required configuration'
      );
    }
  },
});

if (
  isDirectScript(import.meta.url, 'reasoning_auth_check.ts') ||
  isDirectScript(import.meta.url, 'reasoning_auth_check.js')
)
  void runReasoningAuthCheck();
