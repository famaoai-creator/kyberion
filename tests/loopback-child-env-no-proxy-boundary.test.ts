import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Loopback child-env NO_PROXY boundary.
 *
 * A launch site that hands a child process a loopback URL in env
 * (`*_URL` / `*_HOST` / `*_BASE_URL` set to 127.0.0.1 / localhost / [::1], or
 * a computed `[…UrlEnvKey]` / `[…HostEnvKey]` key such as the credential
 * relay's `<PROVIDER>_BASE_URL`) must build that env through the shared
 * loopback guard in `libs/core/foundation/env.ts` — `withLoopbackNoProxy` or
 * `buildProxyPassthroughEnv` — so a proxy-honoring child reaches the loopback
 * service directly instead of sending it to HTTP(S)_PROXY, which cannot reach
 * the parent's 127.0.0.1.
 *
 * New exception: add the file to ALLOWED_WITHOUT_GUARD with a reason (e.g. the
 * value is a client-side default never placed in a child env). Test files are
 * exempt from the scan.
 */
const rootDir = process.cwd();
const SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence'];

/** Files that match the launch-site shape but never put the URL in a child env. */
const ALLOWED_WITHOUT_GUARD: Readonly<Record<string, string>> = {};

const GUARD_CALL = /\b(?:withLoopbackNoProxy|buildProxyPassthroughEnv)\s*\(/;
const LOOPBACK_LITERAL = /(?:127\.0\.0\.1|\blocalhost\b|\[::1\])/;
/** `FOO_URL: '…'`, `env.FOO_HOST = …`, `env['FOO_BASE_URL'] = …` (not `const FOO_URL = …`). */
const LITERAL_ENV_ASSIGN =
  /(^|[^\w$.])(?:[\w$]+(?:\.|\[\s*['"]))?([A-Z][A-Z0-9_]*_(?:URL|HOST|BASE_URL))['"]?\s*\]?\s*(?::|=(?![=>]))\s*([^\n]*)/g;
const DECLARATION = /\b(?:const|let|var|readonly|type|interface)\s+[A-Z][A-Z0-9_]*\s*(?::|=)/;
/** `[route.baseUrlEnvKey]: …` / `env[hostEnvKey] = …` */
const COMPUTED_ENV_ASSIGN = /\[\s*[\w$.]*(?:Url|URL|Host|HOST)EnvKey\s*\]\s*(?::|=(?![=>]))/;

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function isTestFile(relPath: string): boolean {
  return /\.(test|spec)\.[cm]?tsx?$/.test(relPath) || relPath.includes('/__tests__/');
}

/** Lines that inject a loopback URL into an env-shaped key. */
function findLoopbackEnvInjections(source: string): string[] {
  const hits: string[] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (COMPUTED_ENV_ASSIGN.test(line)) {
      hits.push(line);
      continue;
    }
    if (DECLARATION.test(line)) continue;
    for (const match of line.matchAll(LITERAL_ENV_ASSIGN)) {
      if (LOOPBACK_LITERAL.test(match[3] ?? '')) {
        hits.push(line);
        break;
      }
    }
  }
  return hits;
}

function scan(): { unguarded: string[]; staleAllowlist: string[] } {
  const offenders = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const filePath of getAllFiles(path.join(rootDir, root))) {
      const relPath = normalize(path.relative(rootDir, filePath));
      if (!/\.(ts|tsx|mts|cts)$/.test(relPath) || relPath.endsWith('.d.ts')) continue;
      if (relPath.includes('/dist/') || relPath.includes('/.next/') || isTestFile(relPath)) {
        continue;
      }
      const source = String(safeReadFile(filePath, { encoding: 'utf8' }));
      const hits = findLoopbackEnvInjections(source);
      if (hits.length > 0 && !GUARD_CALL.test(source)) offenders.set(relPath, hits);
    }
  }
  const unguarded = [...offenders.keys()]
    .filter((relPath) => !(relPath in ALLOWED_WITHOUT_GUARD))
    .sort()
    .map((relPath) => `${relPath}: ${offenders.get(relPath)![0]}`);
  const staleAllowlist = Object.keys(ALLOWED_WITHOUT_GUARD)
    .filter((relPath) => !offenders.has(relPath))
    .sort();
  return { unguarded, staleAllowlist };
}

describe('Loopback child-env NO_PROXY boundary', () => {
  it('detects literal and computed loopback env injections, not declarations or reads', () => {
    expect(
      findLoopbackEnvInjections(
        [
          "const env = { ...base, KYBERION_HUB_URL: 'http://127.0.0.1:3000' };",
          'childEnv.VOICE_HOST = `localhost`;',
          "env['RELAY_BASE_URL'] = 'http://[::1]:9';",
          '[route.baseUrlEnvKey]: prepared.baseUrl,',
        ].join('\n')
      )
    ).toHaveLength(4);
    expect(
      findLoopbackEnvInjections(
        [
          "export const DEFAULT_ROOM_URL = 'http://127.0.0.1:3046';",
          "const DEFAULT_HOST = '127.0.0.1';",
          "const url = process.env.KYBERION_HUB_URL ?? 'http://127.0.0.1:3000';",
          "if (env.FOO_URL === 'http://localhost') return;",
          "KYBERION_HUB_URL: 'https://hub.example.com',",
          "// KYBERION_HUB_URL: 'http://127.0.0.1'",
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('every launch site injecting a loopback URL into a child env goes through the loopback NO_PROXY guard', () => {
    const { unguarded, staleAllowlist } = scan();
    expect(
      unguarded,
      `loopback URL injected into a child env without the NO_PROXY guard — a proxy-honoring child would send it to HTTP(S)_PROXY, which cannot reach this host's loopback | next: build the env with withLoopbackNoProxy() / buildProxyPassthroughEnv() from libs/core/foundation/env.ts, or add the file to ALLOWED_WITHOUT_GUARD with a reason | evidence:\n${unguarded.join('\n')}`
    ).toEqual([]);
    expect(
      staleAllowlist,
      `ALLOWED_WITHOUT_GUARD lists files that no longer inject a loopback env URL — the exception is stale | next: remove them from the allowlist | evidence: ${staleAllowlist.join(', ')}`
    ).toEqual([]);
  }, 60000);
});
