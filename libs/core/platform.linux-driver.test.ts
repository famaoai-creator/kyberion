import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExecShellScript: vi.fn(() => '0x4a00007\n'),
}));

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return { ...actual, safeExec: mocks.safeExec, safeExecShellScript: mocks.safeExecShellScript };
});

import { __test__ } from './platform.js';

describe('LinuxDriver.captureFocusedWindow', () => {
  it('reads the active window id through the dedicated sh script helper', async () => {
    await new __test__.LinuxDriver().captureFocusedWindow('/tmp/focused.png');

    expect(mocks.safeExecShellScript).toHaveBeenCalledWith(
      'sh',
      "xprop -root _NET_ACTIVE_WINDOW | awk '{print $5}'"
    );
    expect(mocks.safeExec).not.toHaveBeenCalledWith('sh', expect.anything());
    expect(mocks.safeExec).toHaveBeenCalledWith('import', [
      '-window',
      '0x4a00007',
      '/tmp/focused.png',
    ]);
  });
});
