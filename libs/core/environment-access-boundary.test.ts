import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const SOURCES = [
  ['libs/core/core.ts', /process\.env\.(?:LOG_LEVEL|NODE_ENV|DEBUG)/u],
  ['scripts/lib/harness.ts', /process\.env\.LOG_LEVEL/u],
  ['scripts/demos/demo_telegram_flow.ts', /process\.env\.MISSION_ROLE/u],
] as const;

describe('environment access boundary', () => {
  it('keeps shared runtime settings behind the registered environment API', () => {
    for (const [relativePath, directAccessPattern] of SOURCES) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      expect(source, relativePath).not.toMatch(directAccessPattern);
      expect(source, relativePath).toContain('getRegisteredEnvText');
    }
  });
});
