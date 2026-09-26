import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MarkTargetResolution,
  ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';

const mocks = vi.hoisted(() => ({
  resolveMarkTarget:
    vi.fn<(target: string, options: ResolveMarkTargetOptions) => Promise<MarkTargetResolution>>(),
  clickAt: vi.fn(),
  rightClickAt: vi.fn(),
  moveMouse: vi.fn(),
}));

vi.mock('@agent/core/mark-target-resolver', () => ({
  resolveMarkTarget: mocks.resolveMarkTarget,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMarkTarget.mockResolvedValue(RESOLVED);
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
    });
    await resolveSystemClickCoordinate(
      { target_mark: 'mark:2', mark_session_id: 'other' },
      'vision-session'
    );
    expect(mocks.resolveMarkTarget).toHaveBeenLastCalledWith('mark:2', { session_id: 'other' });
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
    expect(mocks.resolveMarkTarget).toHaveBeenCalledWith('mark:4', { session_id: 'vision-s' });
    expect(mocks.rightClickAt).toHaveBeenCalledWith(40, 80, 1);
  });
});
