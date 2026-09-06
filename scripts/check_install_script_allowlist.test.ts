import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkInstallScriptAllowlist,
  readWorkspaceTextFile,
} from './check_install_script_allowlist.js';

describe('install script allowlist checker', () => {
  it('uses the foundation text reader for the workspace manifest', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_install_script_allowlist.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('keeps workspace allowBuilds and the governance policy aligned', () => {
    const result = checkInstallScriptAllowlist();
    expect(result.findings).toEqual([]);
    expect(result.packageCount).toBeGreaterThan(0);
  });

  it('rejects a directory replacement before foundation text reading', () => {
    expect(() => readWorkspaceTextFile(pathResolver.rootDir())).toThrow(
      'pnpm-workspace.yaml must be a regular file'
    );
  });
});
