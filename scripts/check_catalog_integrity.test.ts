import { spawnSync } from 'node:child_process';
import { pathResolver, safeReadFile, safeWriteFile, withExecutionContext } from '@agent/core';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = pathResolver.rootDir();
const THEMES_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/media-templates/themes.json'
);

function runCheckCatalogIntegrity(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', 'scripts/check_catalog_integrity.ts'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    }
  );

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe.sequential('check_catalog_integrity', () => {
  let originalThemesJson = '';

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      const previousSudo = process.env.KYBERION_SUDO;
      process.env.KYBERION_SUDO = 'true';
      try {
        if (originalThemesJson) {
          safeWriteFile(THEMES_PATH, originalThemesJson);
        }
      } finally {
        if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
        else process.env.KYBERION_SUDO = previousSudo;
      }
    });
    originalThemesJson = '';
  });

  it('passes on the current repository state', () => {
    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[check:catalogs] OK');
  });

  it('flags drift when the kyberion token theme changes', () => {
    withExecutionContext('mission_controller', () => {
      const previousSudo = process.env.KYBERION_SUDO;
      process.env.KYBERION_SUDO = 'true';
      try {
        originalThemesJson = String(safeReadFile(THEMES_PATH, { encoding: 'utf8' }) || '');
        const payload = JSON.parse(originalThemesJson) as {
          themes?: Record<string, { colors?: Record<string, string> }>;
        };
        const kyberionStandard = payload.themes?.['kyberion-standard'];
        if (!kyberionStandard?.colors) {
          throw new Error('kyberion-standard colors missing');
        }
        kyberionStandard.colors.accent = '#ff0000';
        safeWriteFile(THEMES_PATH, `${JSON.stringify(payload, null, 2)}\n`);
      } finally {
        if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
        else process.env.KYBERION_SUDO = previousSudo;
      }
    });

    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('design-tokens:');
    expect(result.stderr).toContain('kyberion-standard drift');
  });
});
