import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();
const allowedManagedProcessConsumers = [
  'libs/actuators/process-actuator/src/index.ts',
  'libs/actuators/service-actuator/src/index.ts',
  'libs/actuators/service-actuator/src/reconcile-integration.test.ts',
  'libs/core/acp-mediator.ts',
  'libs/core/agent-adapter.ts',
  'libs/core/agent-runtime-supervisor-client.ts',
  'libs/core/agent-runtime-supervisor.test.ts',
  'libs/core/agent-runtime-supervisor.ts',
  'libs/core/mission-orchestration-events.test.ts',
  'libs/core/mission-orchestration-events.ts',
  'scripts/surface_runtime.ts',
  'tests/managed-process.test.ts',
  'tests/surface-auth.test.ts',
].sort((a, b) => a.localeCompare(b));

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Process boundary governance', () => {
  it('confines managed-process API usage to long-lived runtime ownership paths', () => {
    const codeFiles = getAllFiles(rootDir).filter((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath));
    const actual = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.startsWith('dist/'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => !relPath.includes('/.next/'))
      .filter((relPath) => relPath !== 'libs/core/managed-process.ts')
      .filter((relPath) => /\bspawnManagedProcess\b|\bstopManagedProcess\b|\btouchManagedProcess\b/.test(read(relPath)))
      .sort((a, b) => a.localeCompare(b));

    expect(actual).toEqual(allowedManagedProcessConsumers);
  });

  it('keeps ephemeral command actuators off managed-process ownership', () => {
    const browserActuator = read('libs/actuators/browser-actuator/src/index.ts');
    const systemActuator = read('libs/actuators/system-actuator/src/index.ts');

    expect(browserActuator).not.toMatch(/\bspawnManagedProcess\b|\bstopManagedProcess\b|\btouchManagedProcess\b/);
    expect(systemActuator).not.toMatch(/\bspawnManagedProcess\b|\bstopManagedProcess\b|\btouchManagedProcess\b/);
  });
});
