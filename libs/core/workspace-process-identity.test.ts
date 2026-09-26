import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeExecResult: vi.fn() }));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return { ...actual, safeExecResult: mocks.safeExecResult };
});

import {
  isRecordedChildAlive,
  isRecordedProcessAlive,
  processStartMarker,
} from './workspace-process-identity.js';

afterEach(() => {
  mocks.safeExecResult.mockReset();
});

describe('processStartMarker', () => {
  it.skipIf(process.platform === 'win32')(
    'runs ps under the C locale in UTC and returns the raw marker unparsed',
    () => {
      mocks.safeExecResult.mockReturnValue({
        stdout: 'Sat Sep 26 10:00:00 2026\n',
        stderr: '',
        status: 0,
      });
      expect(processStartMarker(4242)).toBe('Sat Sep 26 10:00:00 2026');
      expect(mocks.safeExecResult).toHaveBeenCalledWith(
        'ps',
        ['-p', '4242', '-o', 'lstart='],
        expect.objectContaining({ env: { LC_ALL: 'C', TZ: 'UTC' } })
      );
    }
  );

  it('returns undefined when ps fails or prints nothing', () => {
    mocks.safeExecResult.mockReturnValue({ stdout: '', stderr: 'no such process', status: 1 });
    expect(processStartMarker(4242)).toBeUndefined();
    mocks.safeExecResult.mockReturnValue({ stdout: '  \n', stderr: '', status: 0 });
    expect(processStartMarker(4242)).toBeUndefined();
  });
});

describe('isRecordedProcessAlive', () => {
  it('treats a live pid with a different start marker as recycled', () => {
    const probe = { isPidAlive: () => true, startMarker: () => 'new' };
    expect(isRecordedProcessAlive(7, 'old', probe)).toBe(false);
    expect(isRecordedProcessAlive(7, 'new', probe)).toBe(true);
  });

  it('falls back to pid liveness when no marker can be read', () => {
    expect(
      isRecordedProcessAlive(7, 'old', { isPidAlive: () => true, startMarker: () => undefined })
    ).toBe(true);
  });
});

describe('isRecordedChildAlive', () => {
  it('is false without a child and for a recycled child pid', () => {
    const probe = { isPidAlive: () => true, startMarker: () => 'someone-else' };
    expect(isRecordedChildAlive({}, probe)).toBe(false);
    expect(isRecordedChildAlive({ childPid: 9, childStartedAt: 'child' }, probe)).toBe(false);
    expect(isRecordedChildAlive({ childPid: 9, childStartedAt: 'someone-else' }, probe)).toBe(true);
  });
});
