import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('run browser procedure environment boundary', () => {
  it('routes mission fallback through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_browser_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });

  it('does not statically import browser-actuator from core or the host script', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_browser_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/from ['"]@agent\/browser-actuator['"]/);
    expect(source).not.toMatch(/from ['"].*browser-actuator\/src/);
    expect(source).toContain("from './browser_playwright_executor.js'");
  });

  it('does not treat --tab-id alone as a CDP attach signal', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_browser_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('const connectOverCdp = Boolean(cdpUrl || cdpPort)');
    expect(source).not.toMatch(/connectOverCdp = Boolean\(cdpUrl \|\| cdpPort \|\| tabId\)/);
  });
});
