import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { runInstaller } from './skill_installer.js';

describe('skill_installer', () => {
  it('routes interactive output through the supplied printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/skill_installer.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');

    const print = vi.fn();
    await expect(runInstaller(['--help'], print)).rejects.toMatchObject({ code: 0 });
    expect(print).toHaveBeenCalledWith(expect.stringContaining('Interactive Skill Installer'));
    expect(print).toHaveBeenCalledWith('Usage: pnpm kyberion skill install <bundle-id>');
  });
});
