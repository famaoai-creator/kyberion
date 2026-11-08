import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';

const fixture = vi.hoisted(() => ({
  readCompleted: vi.fn<() => number | null>(() => null),
  readSubmitted: vi.fn<() => number | null>(() => null),
  markSubmitted: vi.fn(),
  unref: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('@agent/core/storage-janitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/storage-janitor')>()),
  readJanitorLastRunMs: fixture.readCompleted,
  readJanitorLastSubmissionMs: fixture.readSubmitted,
  writeJanitorSubmissionMarker: fixture.markSubmitted,
}));

vi.mock('@agent/core/managed-process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/managed-process')>()),
  spawnManagedProcess: fixture.spawn,
}));

import {
  JANITOR_MAINTENANCE_JOB_FLAG,
  maybeSubmitJanitorMaintenanceJob,
} from './run_baseline_check.js';

describe('baseline detached janitor submission', () => {
  afterEach(() => {
    vi.clearAllMocks();
    fixture.readCompleted.mockReturnValue(null);
    fixture.readSubmitted.mockReturnValue(null);
  });

  it('releases the child event-loop reference after managed registration and retains submission evidence', () => {
    const lifecycle: string[] = [];
    fixture.spawn.mockImplementation(() => {
      lifecycle.push('registered');
      return { child: { unref: fixture.unref } };
    });
    fixture.unref.mockImplementation(() => lifecycle.push('unref'));
    fixture.markSubmitted.mockImplementation(() => lifecycle.push('marked'));

    expect(maybeSubmitJanitorMaintenanceJob()).toEqual({
      submitted: true,
      pending: true,
      reason: 'storage janitor job submitted',
    });
    expect(lifecycle).toEqual(['registered', 'unref', 'marked']);
    expect(fixture.unref).toHaveBeenCalledOnce();
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: ['dist/scripts/run_baseline_check.js', JANITOR_MAINTENANCE_JOB_FLAG],
        spawnOptions: expect.objectContaining({ detached: true, stdio: 'ignore' }),
        shutdownPolicy: 'detached',
        metadata: expect.objectContaining({ dryRun: false, pipelineId: 'storage-janitor' }),
      })
    );
  });

  it('does not submit or release another child when completion is fresh', () => {
    fixture.readCompleted.mockReturnValue(Date.now());
    expect(maybeSubmitJanitorMaintenanceJob()).toEqual({
      submitted: false,
      pending: false,
      reason: null,
    });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.unref).not.toHaveBeenCalled();
    expect(fixture.markSubmitted).not.toHaveBeenCalled();
  });

  it('preserves pending status without resubmission when the submission marker is fresh', () => {
    fixture.readSubmitted.mockReturnValue(Date.now());
    expect(maybeSubmitJanitorMaintenanceJob()).toEqual({
      submitted: false,
      pending: true,
      reason: 'storage janitor job is already pending',
    });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.unref).not.toHaveBeenCalled();
    expect(fixture.markSubmitted).not.toHaveBeenCalled();
  });

  it('does not record a submitted job if managed registration fails', () => {
    fixture.spawn.mockImplementation(() => {
      throw new Error('managed registration failed');
    });
    expect(() => maybeSubmitJanitorMaintenanceJob()).toThrow('managed registration failed');
    expect(fixture.unref).not.toHaveBeenCalled();
    expect(fixture.markSubmitted).not.toHaveBeenCalled();
  });

  it('allows natural parent exit while a finite detached managed child remains alive', () => {
    const moduleUrl = pathToFileURL(
      pathResolver.rootResolve('libs/core/dist/tool/managed-process.js')
    ).href;
    const source = `
      import { spawnManagedProcess } from ${JSON.stringify(moduleUrl)};
      const handle = spawnManagedProcess({
        resourceId: 'finite-maintenance-proof-' + process.pid,
        kind: 'service', ownerId: 'fixture', ownerType: 'test',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 3000)'],
        spawnOptions: { detached: true, stdio: 'ignore' },
        shutdownPolicy: 'detached'
      });
      if (process.argv[1] === 'unref') handle.child.unref();
      process.stdout.write(JSON.stringify({
        event: 'oracle', resources: process.getActiveResourcesInfo()
      }) + '\\n');
      process.once('beforeExit', () => process.stdout.write(JSON.stringify({
        event: 'natural-exit', childExitCode: handle.child.exitCode
      }) + '\\n'));
    `;
    const run = (mode: string) => {
      const result = safeExecResult(process.execPath, ['--input-type=module', '-e', source, mode], {
        timeoutMs: 15_000,
      });
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    };
    const retained = run('ref');
    expect(retained[0].resources).toContain('ProcessWrap');
    expect(retained[1]).toEqual({ event: 'natural-exit', childExitCode: 0 });
    const released = run('unref');
    expect(released[0].resources).not.toContain('ProcessWrap');
    expect(released[1]).toEqual({ event: 'natural-exit', childExitCode: null });
  });
});
