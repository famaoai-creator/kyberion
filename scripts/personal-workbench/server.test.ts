import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  PERSONAL_WORKBENCH_DEFAULT_PORT,
  validatePersonalWorkbenchContentLength,
} from './server.js';

describe('personal workbench', () => {
  it('validates configuration in public dry-run mode', async () => {
    const result = await main(['--dry-run', '--tier', 'public'], { dryRun: true });
    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: PERSONAL_WORKBENCH_DEFAULT_PORT,
      listening: false,
    });
  });

  it('requires a tenant for personal operation', async () => {
    await expect(main(['--dry-run'], { dryRun: true })).rejects.toThrow(
      'requires server-side KYBERION_TENANT scope'
    );
  });

  it('bounds declared request size and keeps sensitive behavior behind auth/handoff', () => {
    expect(validatePersonalWorkbenchContentLength('10')).toBe(10);
    expect(() => validatePersonalWorkbenchContentLength('not-a-number')).toThrow();
    const source = readTextFile(pathResolver.rootResolve('scripts/personal-workbench/server.ts'));
    expect(source).toContain("option(args, '--tier') || 'personal'");
    expect(source).toContain("req.headers['x-pw-token']");
    expect(source).toContain('requires_human_approval: true');
    expect(source).not.toContain('node:fs');
  });
});
