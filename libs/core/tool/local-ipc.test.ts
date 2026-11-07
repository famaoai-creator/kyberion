import { describe, expect, it } from 'vitest';
import { isWindowsNamedPipeAddress, resolveLocalIpcAddress } from './local-ipc.js';

describe('local IPC address resolution', () => {
  const pipePrefix =
    String.fromCharCode(92).repeat(2) +
    '.' +
    String.fromCharCode(92) +
    'pipe' +
    String.fromCharCode(92);

  it('keeps Unix socket paths on POSIX platforms', () => {
    expect(resolveLocalIpcAddress('/tmp/kyberion.sock', 'linux')).toBe('/tmp/kyberion.sock');
  });

  it('maps a filesystem identity to a stable, short Windows named pipe', () => {
    const first = resolveLocalIpcAddress('C:/repo/active/shared/runtime/service.sock', 'win32');
    const second = resolveLocalIpcAddress(
      ['c:', 'repo', 'active', 'shared', 'runtime', 'service.sock'].join(String.fromCharCode(92)),
      'win32'
    );
    expect(first).toBe(second);
    expect(first.startsWith(pipePrefix + 'kyberion-')).toBe(true);
    expect(first.slice(first.indexOf('kyberion-') + 'kyberion-'.length)).toMatch(/^[a-f0-9]{40}$/u);
    expect(first.length).toBeLessThan(100);
    expect(isWindowsNamedPipeAddress(first, 'win32')).toBe(true);
  });

  it('preserves explicit named pipe addresses', () => {
    const pipe = pipePrefix + 'kyberion-explicit';
    expect(resolveLocalIpcAddress(pipe, 'win32')).toBe(pipe);
  });
});
