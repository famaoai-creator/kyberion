/**
 * G11: capability command probes and install commands run under a hard
 * spawnSync timeout so a hung binary cannot block doctor / preflight /
 * bootstrap, and a timeout is reported as unavailable / failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  COMMAND_PROBE_TIMEOUT_MS,
  INSTALL_COMMAND_TIMEOUT_MS,
  runCommandProbe,
  runInstallCommand,
} from './environment-capability.js';

function timeoutError(): Error {
  return Object.assign(new Error('spawnSync hung-cli ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

describe('runCommandProbe (G11)', () => {
  beforeEach(() => spawnSyncMock.mockReset());

  it('passes a 10s timeout and reports a timeout as unavailable', () => {
    spawnSyncMock.mockReturnValue({ status: null, signal: 'SIGTERM', error: timeoutError() });
    expect(runCommandProbe('hung-cli', ['--version'])).toEqual({
      available: false,
      reason: 'hung-cli: timed out after 10s',
    });
    expect(COMMAND_PROBE_TIMEOUT_MS).toBe(10_000);
    expect(spawnSyncMock).toHaveBeenCalledWith('hung-cli', ['--version'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  });

  it('keeps the exit-code and spawn-error semantics', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0 });
    expect(runCommandProbe('ok-cli', [])).toEqual({ available: true });
    spawnSyncMock.mockReturnValueOnce({ status: 2 });
    expect(runCommandProbe('bad-cli', [])).toEqual({
      available: false,
      reason: 'bad-cli exited with code 2',
    });
    spawnSyncMock.mockReturnValueOnce({ status: null, error: new Error('spawn missing ENOENT') });
    expect(runCommandProbe('missing', [])).toEqual({
      available: false,
      reason: 'missing: spawn missing ENOENT',
    });
  });
});

describe('runInstallCommand (G11)', () => {
  beforeEach(() => spawnSyncMock.mockReset());

  it('bounds the install with a finite timeout and explains a timeout', () => {
    spawnSyncMock.mockReturnValue({ status: null, signal: 'SIGTERM', error: timeoutError() });
    const result = runInstallCommand('brew', ['install', 'thing']);
    expect(result.failure).toBe('install command timed out after 10 min and was killed (brew)');
    expect(spawnSyncMock).toHaveBeenCalledWith('brew', ['install', 'thing'], {
      stdio: 'inherit',
      timeout: INSTALL_COMMAND_TIMEOUT_MS,
    });
    expect(INSTALL_COMMAND_TIMEOUT_MS).toBe(600_000);
  });

  it('reports success, non-zero exits and spawn errors', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0 });
    expect(runInstallCommand('brew', [])).toEqual({ status: 0 });
    spawnSyncMock.mockReturnValueOnce({ status: 1 });
    expect(runInstallCommand('brew', []).failure).toBe('install command failed with exit code 1');
    spawnSyncMock.mockReturnValueOnce({ status: null, error: new Error('spawn brew ENOENT') });
    expect(runInstallCommand('brew', []).failure).toBe(
      'install command failed to run: spawn brew ENOENT'
    );
  });
});
