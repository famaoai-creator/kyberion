import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from './fs-utils.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

/**
 * DR-01 boundary: the delegated child role (KYBERION_DELEGATED_ROLE) is only
 * ever written by the governed env builders in libs/core/authority.ts
 * (buildExecutionEnv / buildSystemRoleLaunchEnv). Any other writer could hand
 * a child a role the parent never assumed. Tests may set it to simulate a
 * child; production sources may only read or strip it.
 */
const SOURCE_ROOTS = ['libs', 'scripts', 'presence', 'satellites', 'plugins'];
const ALLOWED_WRITERS = new Set(['libs/core/authority.ts']);
const WRITE_PATTERNS = [
  // `KYBERION_DELEGATED_ROLE: …` / `.KYBERION_DELEGATED_ROLE = …` / `['KYBERION_DELEGATED_ROLE'] = …`
  /KYBERION_DELEGATED_ROLE['"]?\]?\s*(?::|=(?!=))/u,
  // `[DELEGATED_ROLE_ENV]: …` / `[DELEGATED_ROLE_ENV] = …`
  /\[\s*DELEGATED_ROLE_ENV\s*\]\s*(?::|=(?!=))/u,
  // setRegisteredEnv('KYBERION_DELEGATED_ROLE', …) / setRegisteredEnv(DELEGATED_ROLE_ENV, …)
  /setRegisteredEnv\(\s*(?:['"]KYBERION_DELEGATED_ROLE['"]|DELEGATED_ROLE_ENV)/u,
];

function isTestSource(rel: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(rel) || /(?:^|\/)(?:tests?|__tests__)\//u.test(rel);
}

describe('DR-01 delegated role write boundary', () => {
  it('writes KYBERION_DELEGATED_ROLE only from libs/core/authority.ts', () => {
    const root = pathResolver.rootDir();
    const offenders: string[] = [];
    for (const dir of SOURCE_ROOTS) {
      for (const file of getAllFiles(path.join(root, dir))) {
        if (!/\.(?:[cm]?[jt]sx?)$/u.test(file)) continue;
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (ALLOWED_WRITERS.has(rel) || isTestSource(rel)) continue;
        const source = String(safeReadFile(file, { encoding: 'utf8' }));
        if (!source.includes('DELEGATED_ROLE')) continue;
        source.split('\n').forEach((line, index) => {
          if (/^\s*(?:\/\/|\/?\*)/u.test(line)) return; // comments
          if (WRITE_PATTERNS.some((pattern) => pattern.test(line))) {
            offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);

  it('recognises the write shapes it guards against', () => {
    const lines = [
      "env: { KYBERION_DELEGATED_ROLE: 'x@y' }",
      "process.env.KYBERION_DELEGATED_ROLE = 'x@y';",
      "env['KYBERION_DELEGATED_ROLE'] = 'x@y';",
      "nextEnv[DELEGATED_ROLE_ENV] = 'x@y';",
      "setRegisteredEnv('KYBERION_DELEGATED_ROLE', 'x@y');",
    ];
    for (const line of lines) {
      expect(
        WRITE_PATTERNS.some((pattern) => pattern.test(line)),
        line
      ).toBe(true);
    }
    expect(
      WRITE_PATTERNS.some((pattern) => pattern.test("if (env.KYBERION_DELEGATED_ROLE === 'x')"))
    ).toBe(false);
  });
});
