import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExecShellScript: vi.fn(() => ''),
}));

vi.mock('./secure-io.js', () => ({
  safeExec: mocks.safeExec,
  safeExecShellScript: mocks.safeExecShellScript,
}));

import { resolveDesktopLaunchAdapter } from './desktop-launch-adapter.js';

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('desktop-launch-adapter', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it('opens on win32 via `cmd /c start "" <target>` through the shell-script helper', () => {
    setPlatform('win32');
    resolveDesktopLaunchAdapter().open('C:\\tmp\\report.html', 'C:\\work');

    expect(mocks.safeExecShellScript).toHaveBeenCalledWith('cmd', 'start', {
      scriptArgs: ['', 'C:\\tmp\\report.html'],
      cwd: 'C:\\work',
    });
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('keeps darwin / linux on the generic exec helper', () => {
    setPlatform('darwin');
    resolveDesktopLaunchAdapter().open('/tmp/a.html', '/tmp');
    setPlatform('linux');
    resolveDesktopLaunchAdapter().open('/tmp/b.html');

    expect(mocks.safeExec).toHaveBeenNthCalledWith(1, 'open', ['/tmp/a.html'], { cwd: '/tmp' });
    expect(mocks.safeExec).toHaveBeenNthCalledWith(2, 'xdg-open', ['/tmp/b.html'], {
      cwd: undefined,
    });
    expect(mocks.safeExecShellScript).not.toHaveBeenCalled();
  });
});
