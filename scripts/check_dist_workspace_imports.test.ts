import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  checkDistWorkspaceImports,
  collectWorkspacePackageNames,
  extractBareImportSpecifiers,
} from './check_dist_workspace_imports.js';

const FIXTURE_ROOT = 'active/shared/tmp/check-dist-workspace-imports';
const FIXTURE_DIR = pathResolver.sharedTmp('check-dist-workspace-imports');

function write(relativePath: string, contents: string): void {
  const fullPath = pathResolver.sharedTmp(`check-dist-workspace-imports/${relativePath}`);
  safeMkdir(
    pathResolver.sharedTmp(
      `check-dist-workspace-imports/${relativePath.split('/').slice(0, -1).join('/')}`
    ),
    { recursive: true }
  );
  safeWriteFile(fullPath, contents);
}

describe('check_dist_workspace_imports', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  describe('extractBareImportSpecifiers', () => {
    it('captures static, side-effect, and dynamic bare specifiers', () => {
      const source = [
        "import { handleAction } from '@actuator/service';",
        "export { thing } from '@agent/core';",
        "import './relative.js';",
        "import 'reflect-metadata';",
        "const mod = await import('@actuator/meeting-browser-driver');",
      ].join('\n');

      expect(extractBareImportSpecifiers(source).sort()).toEqual(
        [
          '@actuator/meeting-browser-driver',
          '@actuator/service',
          '@agent/core',
          'reflect-metadata',
        ].sort()
      );
    });

    it('ignores relative, absolute, and node: specifiers', () => {
      const source = [
        "import x from './local.js';",
        "import y from '../up.js';",
        "import z from 'node:path';",
      ].join('\n');

      expect(extractBareImportSpecifiers(source)).toEqual([]);
    });
  });

  describe('collectWorkspacePackageNames', () => {
    it('finds the real @actuator/service and @agent/core workspace packages', () => {
      const names = collectWorkspacePackageNames();
      expect(names.has('@actuator/service')).toBe(true);
      expect(names.has('@agent/core')).toBe(true);
    });
  });

  describe('checkDistWorkspaceImports', () => {
    it('flags a workspace-scoped bare import that pnpm never linked', () => {
      write(
        'packages/broken-actuator/package.json',
        JSON.stringify({ name: '@fixture/broken-actuator' })
      );
      write(
        'dist/entry.js',
        "import { run } from '@fixture/broken-actuator';\nexport default run;\n"
      );

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([
        `${FIXTURE_ROOT}/dist/entry.js: cannot resolve workspace import '@fixture/broken-actuator' (ERR_MODULE_NOT_FOUND)`,
      ]);
    });

    it('does not flag a bare import that is not a declared workspace package', () => {
      write(
        'packages/broken-actuator/package.json',
        JSON.stringify({ name: '@fixture/broken-actuator' })
      );
      write('dist/entry.js', "import chalk from 'chalk';\nexport default chalk;\n");

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([]);
    });

    it('does not flag a workspace import that pnpm actually links', () => {
      write(
        'dist/entry.js',
        "import { pathResolver } from '@agent/core/path-resolver';\nexport default pathResolver;\n"
      );

      const violations = checkDistWorkspaceImports({
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([]);
    });

    it('keeps the real built dist tree free of unresolvable workspace imports', () => {
      expect(checkDistWorkspaceImports()).toEqual([]);
    }, 60_000);
  });
});
