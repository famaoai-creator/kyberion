import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();

const allowedRuntimeChildProcessConsumers = [
  'libs/core/acp-mediator.ts',
  'libs/core/agent-adapter.ts',
  'libs/core/managed-process.ts',
  'libs/core/pty-engine.ts',
  'libs/core/secure-io.ts',
  'libs/core/provider-discovery.ts',
  'libs/core/agent-lifecycle.ts',
  'libs/core/orchestrator.ts',
  'libs/core/doctor_core.ts',
  'libs/core/src/pfc/PhysicalLayer.ts',
  'libs/actuators/browser-actuator/src/index.ts',
  'libs/actuators/code-actuator/src/index.ts',
  'libs/actuators/modeling-actuator/src/index.ts',
  'libs/actuators/orchestrator-actuator/src/index.ts',
  'satellites/voice-hub/server.ts',
].sort((a, b) => a.localeCompare(b));

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime child_process boundary', () => {
  it('confines direct child_process imports in production runtime code to declared boundaries', () => {
    const codeFiles = getAllFiles(rootDir).filter((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath));
    const actual = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.startsWith('tests/'))
      .filter((relPath) => !relPath.startsWith('dist/'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => !relPath.includes('/.next/'))
      .filter((relPath) => !relPath.startsWith('scripts/'))
      .filter((relPath) => /\bfrom ['"]node:child_process['"]|require\(['"]node:child_process['"]\)/.test(read(relPath)))
      .sort((a, b) => a.localeCompare(b));

    expect(actual).toEqual(allowedRuntimeChildProcessConsumers);
  });
});
