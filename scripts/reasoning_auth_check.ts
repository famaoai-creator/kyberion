import {
  checkAllReasoningBackendAuth,
  checkReasoningBackendAuth,
} from '@agent/core/reasoning-auth-preflight';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const backend = option('--backend');
const results = backend ? [checkReasoningBackendAuth(backend)] : checkAllReasoningBackendAuth();

if (hasFlag('--json')) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  for (const result of results) {
    const missing = result.missing_environment.length
      ? ` missing=${result.missing_environment.join(',')}`
      : '';
    console.log(`${result.mode}: ${result.status}${missing} — ${result.note}`);
  }
}

if (results.some((result) => result.status === 'missing')) process.exitCode = 1;
