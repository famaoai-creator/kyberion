import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResultAsync: vi.fn(async () => ({ stdout: '', stderr: '', status: 0 })),
}));

vi.mock('./secure-io.js', () => ({ safeExecResultAsync: mocks.safeExecResultAsync }));
vi.mock('./windows-powershell.js', () => ({
  powerShellStdinArgs: () => ['-NoProfile', '-EncodedCommand', 'fixed-bootstrap'],
  windowsPowerShellEnv: () => ({ SystemRoot: 'C:\\Windows' }),
}));

import { restrictWindowsNamedPipeAcl } from './windows-named-pipe-security.js';

describe('restrictWindowsNamedPipeAcl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.safeExecResultAsync.mockClear();
  });

  it('hardens Windows named pipes with an explicit current-user DACL', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const address = String.raw`\\.\pipe\kyberion-${'a'.repeat(40)}`;

    await restrictWindowsNamedPipeAcl(address);

    expect(mocks.safeExecResultAsync).toHaveBeenCalledOnce();
    const [command, args, options] = mocks.safeExecResultAsync.mock.calls[0] as [
      string,
      string[],
      { input: string },
    ];
    expect(command).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-EncodedCommand', 'fixed-bootstrap']);
    expect(options.input).toContain(`$pipe = '${address}'`);
    expect(options.input).toContain('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)');
    expect(options.input).toContain('SetSecurityInfo');
  });

  it('does not invoke Windows ACL tooling for Unix sockets or TCP addresses', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    await restrictWindowsNamedPipeAcl('/tmp/kyberion.sock');
    await restrictWindowsNamedPipeAcl('127.0.0.1:4321');

    expect(mocks.safeExecResultAsync).not.toHaveBeenCalled();
  });

  it('fails closed when Windows cannot apply the ACL', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.safeExecResultAsync.mockResolvedValueOnce({
      stdout: '',
      stderr: 'access denied',
      status: 5,
    });

    await expect(
      restrictWindowsNamedPipeAcl(String.raw`\\.\pipe\kyberion-${'b'.repeat(40)}`)
    ).rejects.toThrow(/Windows named-pipe ACL hardening failed: access denied/u);
  });
});
