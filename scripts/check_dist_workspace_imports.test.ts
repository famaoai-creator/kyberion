import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  checkDistWorkspaceImports,
  collectDeclaredThirdPartyDependencyNames,
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

  describe('collectDeclaredThirdPartyDependencyNames', () => {
    it('finds a real third-party runtime dependency declared at the root', () => {
      const names = collectDeclaredThirdPartyDependencyNames();
      expect(names.has('discord.js')).toBe(true);
      expect(names.has('chalk')).toBe(true);
    });

    it('finds a real third-party runtime dependency declared by a workspace package', () => {
      const names = collectDeclaredThirdPartyDependencyNames();
      expect(names.has('@slack/bolt')).toBe(true);
    });

    it('excludes workspace:* specifiers and devDependencies-only packages', () => {
      write(
        'packages/fixture-pkg/package.json',
        JSON.stringify({
          name: '@fixture/fixture-pkg',
          dependencies: { '@agent/core': 'workspace:*', 'real-dep': '^1.0.0' },
          devDependencies: { 'dev-only-dep': '^1.0.0' },
        })
      );

      const names = collectDeclaredThirdPartyDependencyNames([`${FIXTURE_ROOT}/packages`]);
      expect(names.has('real-dep')).toBe(true);
      expect(names.has('@agent/core')).toBe(false);
      expect(names.has('dev-only-dep')).toBe(false);
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

    it('flags a third-party bare import that a package.json declares but nothing links', () => {
      write(
        'packages/broken-satellite/package.json',
        JSON.stringify({
          name: '@fixture/broken-satellite',
          dependencies: { 'totally-unresolvable-fixture-dep': '^1.0.0' },
        })
      );
      write(
        'dist/entry.js',
        "import unresolvable from 'totally-unresolvable-fixture-dep';\nexport default unresolvable;\n"
      );

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([
        `${FIXTURE_ROOT}/dist/entry.js: cannot resolve third-party import 'totally-unresolvable-fixture-dep' (ERR_MODULE_NOT_FOUND)`,
      ]);
    });

    it('does not flag a third-party bare import that no manifest declares', () => {
      write(
        'dist/entry.js',
        "import x from 'nobody-declared-this-fixture-dep';\nexport default x;\n"
      );

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([]);
    });

    it('does not flag a node builtin imported without the node: prefix', () => {
      write('dist/entry.js', "import fs from 'fs';\nexport default fs;\n");

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([]);
    });

    it('honors the third-party allowlist override for a declared-but-exempted specifier', () => {
      write(
        'packages/broken-satellite/package.json',
        JSON.stringify({
          name: '@fixture/broken-satellite',
          dependencies: { 'totally-unresolvable-fixture-dep': '^1.0.0' },
        })
      );
      write(
        'dist/entry.js',
        "import unresolvable from 'totally-unresolvable-fixture-dep';\nexport default unresolvable;\n"
      );

      const violations = checkDistWorkspaceImports({
        packageScanRoots: [`${FIXTURE_ROOT}/packages`],
        scanRoots: [`${FIXTURE_ROOT}/dist`],
        thirdPartyAllowlist: new Set(['totally-unresolvable-fixture-dep']),
      });

      expect(violations).toEqual([]);
    });

    it('resolves a real declared third-party dependency (discord.js) from a real dist location', () => {
      write('dist/entry.js', "import { Client } from 'discord.js';\nexport default Client;\n");

      const violations = checkDistWorkspaceImports({
        scanRoots: [`${FIXTURE_ROOT}/dist`],
      });

      expect(violations).toEqual([]);
    });

    it('keeps the real built dist tree free of unresolvable workspace and third-party imports', () => {
      expect(checkDistWorkspaceImports()).toEqual([]);
    }, 60_000);
  });
});
