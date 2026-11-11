import { describe, expect, it, vi } from 'vitest';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main, orgRoleArgument } from './compose_mission_team.js';

describe('mission team composition entrypoint', () => {
  it('keeps composition output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/compose_mission_team.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).toContain('loadStateAtPath(');
    expect(source).not.toContain('readJson<');
    expect(source).not.toContain('console.log(');
  });

  it('never copies the mission Org Role into the execution persona (concept model v2 D5)', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/compose_mission_team.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).not.toContain("setRegisteredEnv('KYBERION_BASE_ROLE'");
  });

  it('handles help without requiring a mission or writing bindings', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 'help',
      usage: expect.stringContaining('mission:compose-team'),
    });
  });

  it('selects the Org Role with --org-role; --persona is a deprecated alias for one release', () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      expect(orgRoleArgument('qa_lead', undefined)).toBe('qa_lead');
      expect(warn).not.toHaveBeenCalled();
      expect(orgRoleArgument(undefined, undefined)).toBeUndefined();

      expect(orgRoleArgument(undefined, 'qa_lead')).toBe('qa_lead');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('--persona is retired'));
      warn.mockClear();

      // Both given: --org-role wins and the legacy flag is not consulted.
      expect(orgRoleArgument('qa_lead', 'product_manager')).toBe('qa_lead');
      expect(orgRoleArgument('', 'product_manager')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/compose_mission_team.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("orgRoleArgument(argv['org-role'], argv.persona)");
  });
});
