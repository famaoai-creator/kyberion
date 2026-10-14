import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeLstat: vi.fn(),
  safeMkdir: vi.fn(),
  safeMoveSync: vi.fn(),
  safeRmSync: vi.fn(),
  withLockSync: vi.fn(),
}));
vi.mock('./secure-io.js', () => ({
  ...io,
  safeExecResult: (...args: unknown[]) =>
    args[0] === '/usr/bin/swiftc' && (args[1] as string[])[0] === '--version'
      ? { status: 0, stdout: 'Swift version 6.0', stderr: '' }
      : io.safeExecResult(...args),
}));
vi.mock('./path-resolver.js', () => ({ rootResolve: (p: string) => '/test/' + p }));
vi.mock('./storage-layout.js', () => ({
  SYSTEM_PARTITION: { kind: 'system' },
  resolveStorageFloor: (_floor: string, _partition: unknown, domain: string, ...parts: string[]) =>
    ['/test/active/shared/cache/system', domain, ...parts].join('/'),
}));
vi.mock('./foundation/lock-utils.js', () => ({
  withLockSync: io.withLockSync,
}));
import {
  _resetMacOSNativeCompilerCacheForTests,
  getMacOSFocusedInput,
  listMacOSAXWindows,
  performMacOSMouseOperation,
  probeMacOSNativeAutomation,
} from './macos-native-automation.js';
const originalPlatform = process.platform;
const stat = { isFile: () => true, isSymbolicLink: () => false, size: 50, mode: 0o755 };
function platform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
function response(value: unknown) {
  return {
    status: 0,
    stdout: JSON.stringify(
      value && typeof value === 'object' && 'accessibility' in value
        ? { automation: 'unknown', browser_automation: 'unknown', ...value }
        : value
    ),
    stderr: '',
  };
}
describe('macOS native automation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    io.withLockSync.mockImplementation((_key: string, callback: () => unknown) => callback());
    _resetMacOSNativeCompilerCacheForTests();
    platform('darwin');
    io.safeReadFile.mockReturnValue('source');
    io.safeLstat.mockReturnValue(stat);
  });
  afterEach(() => platform(originalPlatform));
  it('does not launch processes on unsupported platforms', () => {
    platform('linux');
    expect(probeMacOSNativeAutomation().accessibility).toBe('unsupported');
    performMacOSMouseOperation({ type: 'move', x: 1, y: 2 });
    expect(listMacOSAXWindows('Finder')).toEqual([]);
    expect(getMacOSFocusedInput().editable).toBe(false);
    expect(io.safeExecResult).not.toHaveBeenCalled();
  });
  it('reports actual denial independently of helper availability and blocks input', () => {
    io.safeExecResult.mockReturnValue(
      response({ accessibility: 'denied', screen_recording: 'granted' })
    );
    expect(probeMacOSNativeAutomation()).toMatchObject({
      available: true,
      accessibility: 'denied',
    });
    expect(() => performMacOSMouseOperation({ type: 'click', x: 1, y: 2 })).toThrow(
      'macos_accessibility_denied'
    );
    expect(io.safeExecResult.mock.calls.every((call) => call[1][0] === 'probe')).toBe(true);
  });
  it('classifies failures and malformed responses as unknown without exposing paths', () => {
    io.safeExecResult.mockReturnValue({
      status: 1,
      stdout: '/private/secret',
      stderr: '/private/secret',
    });
    expect(probeMacOSNativeAutomation()).toEqual({
      available: false,
      automation: 'unknown',
      browser_automation: 'unknown',
      accessibility: 'unknown',
      screen_recording: 'unknown',
      reason: 'native_execution_failed',
    });
    io.safeExecResult.mockReturnValue(response({ accessibility: true }));
    expect(probeMacOSNativeAutomation().accessibility).toBe('unknown');
  });
  it('rejects invalid values and command injection before any native call', () => {
    for (const x of [NaN, Infinity, 100001])
      expect(() => performMacOSMouseOperation({ type: 'move', x, y: 1 })).toThrow(
        'invalid_mouse_coordinate'
      );
    expect(() => performMacOSMouseOperation({ type: 'click', x: 1, y: 2, count: 11 })).toThrow(
      'invalid_mouse_amount'
    );
    expect(() =>
      performMacOSMouseOperation({ type: 'scroll', x: 1, y: 2, direction: 'down', amount: -1 })
    ).toThrow('invalid_mouse_amount');
    expect(() => performMacOSMouseOperation({ type: 'injected' } as never)).toThrow(
      'invalid_mouse_operation'
    );
    expect(io.safeExecResult).not.toHaveBeenCalled();
  });
  it('uses bounded direct arguments and requires a positive native action receipt', () => {
    io.safeExecResult
      .mockReturnValueOnce(response({ accessibility: 'granted', screen_recording: 'denied' }))
      .mockReturnValueOnce(response({ ok: true }));
    performMacOSMouseOperation({ type: 'click', x: 10, y: 20, button: 'right', count: 2 });
    expect(io.safeExecResult).toHaveBeenLastCalledWith(
      expect.stringContaining('/cache/system/macos-automation/automation-'),
      ['mouse', JSON.stringify({ type: 'click', x: 10, y: 20, button: 'right', count: 2 })],
      { timeoutMs: 5000, maxOutputMB: 1 }
    );
  });
  it('compiles missing binaries to an isolated temporary file and publishes atomically', () => {
    io.safeLstat.mockImplementation((p: string) => {
      if (!p.includes('.build-')) throw new Error('missing');
      return stat;
    });
    io.safeExecResult
      .mockReturnValueOnce(response({}))
      .mockReturnValueOnce(response({ accessibility: 'granted', screen_recording: 'denied' }));
    expect(probeMacOSNativeAutomation().available).toBe(true);
    expect(io.safeExecResult.mock.calls[0][0]).toBe('/usr/bin/swiftc');
    expect(io.safeMoveSync).toHaveBeenCalled();
    expect(io.safeRmSync).toHaveBeenCalled();
  });
  it('does not publish missing or non-executable compiler output', () => {
    io.safeLstat.mockImplementation(() => {
      throw new Error('missing');
    });
    io.safeExecResult.mockReturnValue(response({}));
    expect(probeMacOSNativeAutomation().accessibility).toBe('unknown');
    expect(io.safeMoveSync).not.toHaveBeenCalled();
  });
  it('passes application names as JSON data and reports failed AX queries', () => {
    io.safeExecResult.mockReturnValue(response({ windows: ['Window'] }));
    expect(listMacOSAXWindows('App; injection')).toEqual(['Window']);
    expect(io.safeExecResult.mock.calls[0][1]).toEqual([
      'windows',
      JSON.stringify({ application: 'App; injection' }),
    ]);
    io.safeExecResult.mockReturnValue(response({ windows: [1] }));
    expect(() => listMacOSAXWindows('App')).toThrow('macos_windows_unavailable');
  });
  it('returns only focused metadata and never input values', () => {
    io.safeExecResult.mockReturnValue(
      response({
        application: 'App',
        windowTitle: 'Window',
        role: 'AXTextField',
        description: 'Name',
        editable: true,
        value: 'secret',
      })
    );
    expect(getMacOSFocusedInput()).toEqual({
      application: 'App',
      windowTitle: 'Window',
      role: 'AXTextField',
      description: 'Name',
      editable: true,
    });
    io.safeExecResult.mockReturnValue(response({}));
    expect(() => getMacOSFocusedInput()).toThrow('macos_focused_input_unavailable');
  });
  it('preserves all four independent permission states, including absent targets', () => {
    for (const state of ['granted', 'denied', 'unsupported', 'unknown']) {
      io.safeExecResult.mockReturnValue(
        response({
          automation: state,
          browser_automation: state,
          accessibility: 'granted',
          screen_recording: 'unsupported',
        })
      );
      expect(probeMacOSNativeAutomation()).toEqual({
        available: true,
        automation: state,
        browser_automation: state,
        accessibility: 'granted',
        screen_recording: 'unsupported',
      });
    }
    io.safeExecResult.mockReturnValue(
      response({
        automation: 'unknown',
        browser_automation: 'unknown',
        accessibility: 'denied',
        screen_recording: 'denied',
      })
    );
    expect(probeMacOSNativeAutomation()).toMatchObject({
      available: true,
      automation: 'unknown',
      browser_automation: 'unknown',
    });
  });
  it('supports bounded triple and multiple clicks', () => {
    for (const count of [3, 10]) {
      io.safeExecResult
        .mockReturnValueOnce(response({ accessibility: 'granted', screen_recording: 'granted' }))
        .mockReturnValueOnce(response({ ok: true }));
      expect(() => performMacOSMouseOperation({ type: 'click', x: 1, y: 2, count })).not.toThrow();
    }
    expect(() => performMacOSMouseOperation({ type: 'click', x: 1, y: 2, count: 11 })).toThrow(
      'invalid_mouse_amount'
    );
  });

  it('compiles an immutable snapshot even if the original source changes during build', () => {
    io.safeReadFile.mockReturnValueOnce('source-before').mockReturnValue('source-after');
    io.safeLstat.mockImplementation((p: string) => {
      if (!p.includes('.build-')) throw new Error('missing');
      return stat;
    });
    io.safeExecResult
      .mockReturnValueOnce(response({}))
      .mockReturnValueOnce(response({ accessibility: 'granted', screen_recording: 'granted' }));
    expect(probeMacOSNativeAutomation().available).toBe(true);
    const snapshot = io.safeWriteFile.mock.calls[0][0];
    expect(snapshot).toMatch(/cache\/system\/macos-automation\/automation-.*\.build-.*\.swift$/);
    expect(io.safeWriteFile).toHaveBeenCalledWith(snapshot, 'source-before', {
      createOnly: true,
      mode: 0o600,
    });
    expect(io.safeExecResult.mock.calls[0][1]).toContain(snapshot);
    expect(io.safeExecResult.mock.calls[0][1]).not.toContain(
      '/test/libs/core/macos-native-automation.swift'
    );
    expect(io.safeReadFile).toHaveBeenCalledTimes(1);
    expect(io.safeRmSync).toHaveBeenCalledWith(snapshot, { force: true });
  });
  it('does not compile or remove a colliding snapshot path', () => {
    io.safeLstat.mockImplementation(() => {
      throw new Error('missing');
    });
    io.safeWriteFile.mockImplementation(() => {
      throw new Error('EEXIST');
    });
    expect(probeMacOSNativeAutomation().available).toBe(false);
    expect(io.safeExecResult).not.toHaveBeenCalled();
    expect(io.safeRmSync).not.toHaveBeenCalled();
  });

  it('preserves normal application/window focus with no focused input control', () => {
    io.safeExecResult.mockReturnValue(
      response({
        application: 'App',
        windowTitle: 'Window',
        role: '',
        description: '',
        editable: false,
      })
    );
    expect(getMacOSFocusedInput()).toEqual({
      application: 'App',
      windowTitle: 'Window',
      role: '',
      description: '',
      editable: false,
    });
    io.safeExecResult.mockReturnValue(
      response({ application: '', windowTitle: '', role: '', description: '', editable: false })
    );
    expect(getMacOSFocusedInput()).toEqual({
      application: '',
      windowTitle: '',
      role: '',
      description: '',
      editable: false,
    });
    io.safeExecResult.mockReturnValue({ status: 1, stdout: '', stderr: 'access denied' });
    expect(() => getMacOSFocusedInput()).toThrow('macos_focused_input_unavailable');
  });
  it('returns safe diagnostic categories for malformed response and compilation failure', () => {
    io.safeExecResult.mockReturnValue({
      status: 0,
      stdout: 'not-json /private/secret',
      stderr: '',
    });
    expect(probeMacOSNativeAutomation().reason).toBe('native_response_invalid');
    io.safeLstat.mockImplementation(() => {
      throw new Error('missing');
    });
    io.safeExecResult.mockReturnValue({ status: 1, stdout: '', stderr: '/private/compiler-path' });
    expect(probeMacOSNativeAutomation().reason).toBe('native_compilation_failed');
  });
  it('allows lock wait to outlast a concurrent cold compilation without reclaiming a live owner', () => {
    io.safeLstat.mockImplementation((p: string) => {
      if (!p.includes('.build-')) throw new Error('missing');
      return stat;
    });
    io.safeExecResult
      .mockReturnValueOnce(response({}))
      .mockReturnValueOnce(response({ accessibility: 'granted', screen_recording: 'granted' }));
    expect(probeMacOSNativeAutomation().available).toBe(true);
    expect(io.withLockSync).toHaveBeenCalledWith(
      expect.stringContaining('macos-automation-build-'),
      expect.any(Function),
      125000
    );
    expect(io.safeExecResult.mock.calls[0][2].timeoutMs).toBeLessThan(
      io.withLockSync.mock.calls[0][2]
    );
  });
  it('does not compile or expose lock diagnostic paths when lock acquisition times out', () => {
    io.safeLstat.mockImplementation(() => {
      throw new Error('missing');
    });
    io.withLockSync.mockImplementation(() => {
      throw new Error('[LOCK_TIMEOUT] /private/path');
    });
    expect(probeMacOSNativeAutomation().reason).toBe('native_probe_failed');
    expect(io.safeExecResult).not.toHaveBeenCalled();
    expect(io.safeWriteFile).not.toHaveBeenCalled();
  });
});
