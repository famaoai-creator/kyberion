import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MarkTargetResolution,
  ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeWriteFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({
  resolveMarkTarget:
    vi.fn<(target: string, options: ResolveMarkTargetOptions) => Promise<MarkTargetResolution>>(),
  loadMarks: vi.fn(),
  captureScreenshot: vi.fn(),
  dhashFile: vi.fn(),
  clickAt: vi.fn(),
  rightClickAt: vi.fn(),
  moveMouse: vi.fn(),
}));

vi.mock('@agent/core/mark-target-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/mark-target-resolver')>()),
  resolveMarkTarget: mocks.resolveMarkTarget,
  loadMarks: mocks.loadMarks,
}));
vi.mock('@agent/core/screen-capture-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/screen-capture-bridge')>()),
  createScreenCaptureBridge: () => ({ captureScreenshot: mocks.captureScreenshot }),
}));
vi.mock('@agent/core/image-dhash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/image-dhash')>()),
  dhashFile: mocks.dhashFile,
}));
vi.mock('@agent/core/os-automation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/os-automation')>()),
  clickAt: mocks.clickAt,
  rightClickAt: mocks.rightClickAt,
  moveMouse: mocks.moveMouse,
}));
vi.mock('@agent/core/computer-surface', () => ({ emitComputerSurfacePatch: vi.fn() }));

const { resolveSystemClickCoordinate } = await import('./system-mark-target.js');
const { handleSystemAction } = await import('./system-action-helpers.js');

const RESOLVED: MarkTargetResolution = { n: 2, marks_id: 'm1', x: 225, y: 110 };
const SCREEN = '00ff00ff00ff00ff';
const CHECK_DIR = pathResolver.sharedTmp('mark-target-checks');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMarkTarget.mockResolvedValue(RESOLVED);
  mocks.loadMarks.mockReturnValue(undefined);
  mocks.captureScreenshot.mockImplementation(async (request: { save_path: string }) => {
    safeWriteFile(request.save_path, 'png');
    return { save_path: request.save_path };
  });
  mocks.dhashFile.mockResolvedValue(SCREEN);
});

describe('resolveSystemClickCoordinate', () => {
  it.each([
    [
      'coordinate wins over target_mark',
      { coordinate: { x: 5, y: 6 }, target_mark: 'mark:2' },
      { x: 5, y: 6 },
    ],
    ['x/y win over target_mark', { x: 7, y: 0, target_mark: 'mark:2' }, { x: 7, y: 0 }],
    ['nothing to resolve', {}, undefined],
  ])('%s', async (_name, input, expected) => {
    await expect(resolveSystemClickCoordinate(input, 'session')).resolves.toEqual(expected);
    expect(mocks.resolveMarkTarget).not.toHaveBeenCalled();
  });

  it('resolves target_mark against mark_session_id, else the caller session', async () => {
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2', marks_id: 'm1' }, 'vision-session')
    ).resolves.toEqual({ x: 225, y: 110 });
    expect(mocks.resolveMarkTarget).toHaveBeenLastCalledWith('mark:2', {
      session_id: 'vision-session',
      marks_id: 'm1',
      current_dhash: SCREEN,
    });
    await resolveSystemClickCoordinate(
      { target_mark: 'mark:2', mark_session_id: 'other' },
      'vision-session'
    );
    expect(mocks.resolveMarkTarget).toHaveBeenLastCalledWith('mark:2', {
      session_id: 'other',
      current_dhash: SCREEN,
    });
  });
});

describe('current screen verification', () => {
  it('hashes a fresh capture of the marked display at a unique path and deletes it', async () => {
    mocks.loadMarks.mockReturnValue({ display: { index: 0 } });
    await resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session');
    await resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session');
    const [first, second] = mocks.captureScreenshot.mock.calls.map(
      ([request]) => (request as { save_path: string }).save_path
    );
    expect(mocks.captureScreenshot).toHaveBeenCalledWith({ save_path: first, display_index: 0 });
    expect(path.dirname(first)).toBe(CHECK_DIR);
    expect(first).not.toBe(second);
    expect(mocks.dhashFile).toHaveBeenCalledWith(first);
    expect(safeExistsSync(first)).toBe(false);
    expect(mocks.resolveMarkTarget.mock.calls[0][1].current_dhash).toBe(SCREEN);
  });

  it('never trusts a caller-supplied hash: an echoed stale image_dhash still gets a fresh capture', async () => {
    const staleEcho = 'abcdabcdabcdabcd';
    await resolveSystemClickCoordinate(
      { target_mark: 'mark:2', current_dhash: staleEcho } as Parameters<
        typeof resolveSystemClickCoordinate
      >[0],
      'vision-session'
    );
    expect(mocks.captureScreenshot).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMarkTarget.mock.calls[0][1].current_dhash).toBe(SCREEN);
  });

  it('deletes the capture when the bridge throws after writing it', async () => {
    let written = '';
    mocks.captureScreenshot.mockImplementationOnce(async (request: { save_path: string }) => {
      written = request.save_path;
      safeWriteFile(written, 'png');
      throw new Error('post-capture failure');
    });
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session')
    ).rejects.toThrow(/^\[MARK_STALE\]/);
    expect(written).not.toBe('');
    expect(safeExistsSync(written)).toBe(false);
  });

  it('refuses a mark without any session before capturing the screen', async () => {
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2' }, undefined)
    ).rejects.toThrow(/^\[MARK_INVALID\] mark:2 needs mark_session_id/);
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
  });

  it('refuses with MARK_STALE when the current screen cannot be captured', async () => {
    mocks.captureScreenshot.mockRejectedValueOnce(new Error('screencapture not found'));
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session')
    ).rejects.toThrow(/^\[MARK_STALE\] cannot capture the current screen/);
    expect(mocks.resolveMarkTarget).not.toHaveBeenCalled();
  });
});

describe('multi-display marks', () => {
  it('shifts a secondary-display mark by the recorded display origin', async () => {
    mocks.resolveMarkTarget.mockResolvedValueOnce({
      ...RESOLVED,
      display: { index: 1, origin: { x: 1440, y: -200 } },
    });
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session')
    ).resolves.toEqual({ x: 1665, y: -90 });
  });

  it('refuses a secondary-display mark whose origin is unknown', async () => {
    mocks.resolveMarkTarget.mockResolvedValueOnce({ ...RESOLVED, display: { index: 2 } });
    await expect(
      resolveSystemClickCoordinate({ target_mark: 'mark:2' }, 'vision-session')
    ).rejects.toThrow(/^\[MARK_INVALID\] marks m1 came from display 2/);
  });
});

describe('system-actuator target_mark wiring', () => {
  it('computer_interaction left_click without coordinate clicks the mark center', async () => {
    const result = await handleSystemAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'vision-session',
      action: { type: 'left_click', target_mark: 'mark:2' },
    });
    expect(result.status).toBe('succeeded');
    expect(mocks.resolveMarkTarget).toHaveBeenCalledWith('mark:2', {
      session_id: 'vision-session',
      current_dhash: SCREEN,
    });
    expect(mocks.clickAt).toHaveBeenCalledWith(225, 110, 1);
  });

  it('computer_interaction refuses a stale mark without clicking', async () => {
    mocks.resolveMarkTarget.mockRejectedValueOnce(new Error('[MARK_STALE] marks expired'));
    await expect(
      handleSystemAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'double_click', target_mark: 'mark:1', mark_session_id: 'vision-s' },
      })
    ).rejects.toThrow('[MARK_STALE]');
    expect(mocks.clickAt).not.toHaveBeenCalled();
  });

  it('pipeline mouse_click resolves target_mark when x/y are absent', async () => {
    mocks.resolveMarkTarget.mockResolvedValueOnce({ n: 4, marks_id: 'm2', x: 40, y: 80 });
    const result = await handleSystemAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'mouse_click',
          params: { target_mark: 'mark:4', mark_session_id: 'vision-s', button: 'right' },
        },
      ],
    });
    expect(result.status).toBe('succeeded');
    expect(mocks.resolveMarkTarget).toHaveBeenCalledWith('mark:4', {
      session_id: 'vision-s',
      current_dhash: SCREEN,
    });
    expect(mocks.rightClickAt).toHaveBeenCalledWith(40, 80, 1);
  });
});
