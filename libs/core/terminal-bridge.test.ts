import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadTerminalSessionStateAtPath, terminalBridge } from './terminal-bridge.js';

describe('terminal bridge session state boundary', () => {
  const sessionId = `state-loader-test-${process.pid}`;
  const sessionRoot = pathResolver.shared(`runtime/terminal/${sessionId}`);
  const statePath = path.join(sessionRoot, 'state.json');

  afterEach(() => {
    safeRmSync(sessionRoot, { recursive: true, force: true });
  });

  it('loads a schema-valid terminal session state', () => {
    safeWriteFile(statePath, JSON.stringify({ pid: process.pid, status: 'running' }));

    expect(loadTerminalSessionStateAtPath(statePath)).toEqual({
      pid: process.pid,
      status: 'running',
    });
  });

  it('fails closed for malformed and non-regular session state', () => {
    safeWriteFile(statePath, JSON.stringify({ pid: 'not-a-pid' }));
    expect(loadTerminalSessionStateAtPath(statePath)).toBeNull();

    safeRmSync(statePath, { force: true });
    safeMkdir(statePath, { recursive: true });
    expect(loadTerminalSessionStateAtPath(statePath)).toBeNull();
  });

  it('loads the latest response through the governed response catalog', () => {
    const latestPath = path.join(sessionRoot, 'out', 'latest_response.json');
    safeWriteFile(latestPath, JSON.stringify({ data: { message: 'ready', extra: true } }));

    expect(terminalBridge.readLatestOutput('rt-main', sessionId, 'ReflexTerminal')).toBe('ready');
  });
});
