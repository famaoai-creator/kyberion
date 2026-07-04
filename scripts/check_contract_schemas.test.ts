import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

const ROOT = pathResolver.rootDir();
const FIXTURE_PATH = pathResolver.rootResolve(
  'knowledge/product/governance/z-test-golden-scenario-catalog.json'
);

function runCheckContractSchemas(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', 'scripts/check_contract_schemas.ts'],
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

describe.sequential('check_contract_schemas', () => {
  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      const previousSudo = process.env.KYBERION_SUDO;
      process.env.KYBERION_SUDO = 'true';
      try {
        if (safeExistsSync(FIXTURE_PATH)) {
          safeRmSync(FIXTURE_PATH, { force: true });
        }
      } finally {
        if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
        else process.env.KYBERION_SUDO = previousSudo;
      }
    });
  });

  it('passes on the current repository state', () => {
    const result = runCheckContractSchemas();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[check:contract-schemas] OK');
  });

  it('flags unmanaged golden scenario catalogs with the fixture name', () => {
    withExecutionContext('mission_controller', () => {
      const previousSudo = process.env.KYBERION_SUDO;
      process.env.KYBERION_SUDO = 'true';
      try {
        safeWriteFile(
          FIXTURE_PATH,
          JSON.stringify(
            {
              schema_version: 'scenario-catalog.v1',
              entries: [],
            },
            null,
            2
          )
        );
      } finally {
        if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
        else process.env.KYBERION_SUDO = previousSudo;
      }
    });

    const result = runCheckContractSchemas();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('z-test-golden-scenario-catalog.json');
    expect(result.stderr).toContain('unmanaged deterministic catalog');
  });
});
