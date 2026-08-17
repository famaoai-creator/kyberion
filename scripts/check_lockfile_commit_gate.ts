/** PI-12: require an explicit opt-in for pnpm-lock.yaml changes. */
import { safeExec } from '../libs/core/secure-io.js';

const baseRef = process.env.GITHUB_BASE_REF?.trim();
const safeBase = baseRef && /^[A-Za-z0-9._/-]+$/u.test(baseRef) ? baseRef : undefined;
const changed = new Set<string>();

function collect(args: string[]): void {
  try {
    for (const file of safeExec('git', args)
      .split(/\r?\n/u)
      .map((entry) => entry.trim())) {
      if (file) changed.add(file);
    }
  } catch {
    // A missing remote/base is handled conservatively by the local diff below.
  }
}

collect(['diff', '--name-only', '--', 'pnpm-lock.yaml']);
if (safeBase) collect(['diff', '--name-only', `${safeBase}...HEAD`, '--', 'pnpm-lock.yaml']);

if (changed.has('pnpm-lock.yaml') && process.env.PI_ALLOW_LOCKFILE_CHANGE !== '1') {
  console.error(
    '[check:lockfile-commit-gate] FAILED: pnpm-lock.yaml changed; set PI_ALLOW_LOCKFILE_CHANGE=1 with review evidence.'
  );
  process.exitCode = 1;
} else {
  console.log('[check:lockfile-commit-gate] OK');
}
