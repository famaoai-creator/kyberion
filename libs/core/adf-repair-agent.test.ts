import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAndRepairAdf } from './adf-repair-agent.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

vi.mock('./delegated-task-observability.js', () => ({
  startDelegatedTaskTrace: vi.fn(() => ({ traceId: 'test-trace' })),
  completeDelegatedTaskTrace: vi.fn(),
}));

const tmpRoot = pathResolver.sharedTmp('adf-repair-agent-tests');

function fixturePath(name: string): string {
  return path.join(tmpRoot, name);
}

function writeFixture(name: string, body: string): string {
  const filePath = fixturePath(name);
  safeWriteFile(filePath, body, { encoding: 'utf8', mkdir: true });
  return filePath;
}

function readFixture(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

function registerFakeRepairBackend(delegateTask: ReasoningBackend['delegateTask']) {
  const backend: ReasoningBackend = {
    ...stubReasoningBackend,
    name: 'fake-repair',
    delegateTask,
  };
  registerReasoningBackend(backend);
}

describe('validateAndRepairAdf', () => {
  beforeEach(() => {
    safeMkdir(tmpRoot, { recursive: true });
    resetReasoningBackend();
  });

  afterEach(() => {
    resetReasoningBackend();
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('passes valid ADF input through without repair', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'valid.json',
      JSON.stringify({ capability: 'demo', action: 'run' }, null, 2)
    );

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result).toEqual({ repaired: false });
    expect(delegateTask).not.toHaveBeenCalled();
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('repairs lightweight JSON defects without delegating to the reasoning backend', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture('trailing-comma.json', '{ capability: "demo", action: "run", }');

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result).toEqual({ repaired: false });
    expect(delegateTask).not.toHaveBeenCalled();
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('uses a delegated JSON repair result only after it validates against the schema', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo', action: 'run' }));
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'schema-invalid.json',
      JSON.stringify({ capability: 'demo' }, null, 2)
    );

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(true);
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('delegates unrecoverable parse errors and writes the repaired JSON returned by the backend', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo', action: 'run' }));
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture('unparseable.json', 'this is not json');

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(true);
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('does not overwrite the file when delegated repair output is invalid', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo' }));
    registerFakeRepairBackend(delegateTask);
    const original = JSON.stringify({ capability: 'demo' }, null, 2);
    const filePath = writeFixture('unrepaired.json', original);

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(false);
    expect(result.errors?.join('\n')).toContain('action');
    expect(readFixture(filePath)).toBe(original);
  });

  it('rejects pipeline ADF guardrail violations without delegating', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'guardrail.json',
      JSON.stringify(
        {
          steps: [
            {
              op: 'demo:step',
              params: {},
              hooks: {
                before: [
                  {
                    type: 'command',
                    cmd: 'rm -rf /',
                  },
                ],
              },
            },
          ],
        },
        null,
        2
      )
    );

    const result = await validateAndRepairAdf(filePath, 'pipeline-adf');

    expect(result.repaired).toBe(false);
    expect(result.report).toContain('ADF guardrails failed');
    expect(delegateTask).not.toHaveBeenCalled();
  });
});
