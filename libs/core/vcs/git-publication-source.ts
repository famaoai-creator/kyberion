import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { detectTier } from '../tier-guard.js';
import { prPublicationSourceForRelativePath } from './github.js';
import type { VcsCommandRunner } from './git.js';
import { runHardenedGitProbe } from '../shell/git-probe-hardening.js';
import { governVcsCommand } from './external-vcs.js';

export interface GitPublicationSource {
  publication_source_tier: 'public' | 'personal' | 'confidential' | 'protected_or_unknown';
  publication_source_tenant?: string;
  publication_source_scope_conflict?: true;
  publication_history_sha256?: string;
}

/** Inspect new reachable history, including deleted files. A verified remote
 * baseline may exclude ancestry already delivered to that exact destination.
 * The runtime scope remains the taint floor for content copied into code. */
export function readGitPublicationSource(
  cwd: string,
  head: string,
  run: VcsCommandRunner,
  remoteHead?: string
): GitPublicationSource {
  const unknown = { publication_source_tier: 'protected_or_unknown' as const };
  let result;
  try {
    const shallow = runHardenedGitProbe(['rev-parse', '--is-shallow-repository'], { cwd }, run);
    if (shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== 'false') return unknown;
    result = runHardenedGitProbe(
      [
        'log',
        '--format=',
        '--name-only',
        '-z',
        '--full-history',
        '--root',
        '--no-renames',
        head,
        ...(remoteHead ? ['--not', remoteHead] : []),
      ],
      { cwd, timeoutMs: 30_000, maxOutputMB: 4 },
      run
    );
  } catch {
    return unknown;
  }
  if (result.error || result.status !== 0 || (!result.stdout && !remoteHead)) return unknown;
  let tier: 'public' | 'personal' | 'confidential' = 'public';
  let tenant: string | undefined;
  for (const raw of result.stdout.split('\0')) {
    // Git emits a newline between commit records, outside the NUL path names.
    const name = raw.replace(/^\n/u, '');
    if (!name) continue;
    if (name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..'))
      return unknown;
    const absolute = path.join(pathResolver.rootDir(), name);
    if (detectTier(absolute) === 'public') continue;
    const source = prPublicationSourceForRelativePath(name);
    if (typeof source !== 'object') return unknown;
    if (source.tier === 'personal') {
      if (tenant) return { ...unknown, publication_source_scope_conflict: true };
      tier = 'personal';
    } else {
      if (tier === 'personal' || (tenant && tenant !== source.tenantSlug))
        return { ...unknown, publication_source_scope_conflict: true };
      tier = 'confidential';
      tenant = source.tenantSlug;
    }
  }
  return {
    publication_source_tier: tier,
    ...(tenant ? { publication_source_tenant: tenant } : {}),
    publication_history_sha256: createHash('sha256').update(result.stdout).digest('hex'),
  };
}

/** Remote tracking refs are caller-editable; only an actual URL-bound remote
 * advertisement may prove that earlier history is already at the destination. */
export function readGitRemotePublicationHead(cwd: string, url: string, run: VcsCommandRunner) {
  const result = governVcsCommand(
    'vcs:read_remote',
    { url, ref: 'HEAD' },
    () =>
      run('git', ['ls-remote', '--exit-code', '--', url, 'HEAD'], {
        cwd,
        timeoutMs: 15_000,
        maxOutputMB: 1,
      }),
    false
  );
  if (result.error) return { verified: false };
  if (result.status === 2 && !result.stdout.trim()) return { verified: true };
  const match = result.stdout.trim().match(/^([a-f0-9]{40,64})\tHEAD$/iu);
  return result.status === 0 && match ? { verified: true, head: match[1] } : { verified: false };
}
