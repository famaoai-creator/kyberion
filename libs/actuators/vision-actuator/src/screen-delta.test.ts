import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

const mocks = vi.hoisted(() => ({
  safeExistsSync: vi.fn(() => true),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
}));

const { handleDescribeScreenDelta } = await import('./screen-delta.js');

const deltaResult = {
  session_id: 's1',
  image: { width: 8, height: 8 },
  grid: { cols: 1, rows: 1 },
  tiles: [],
  stats: {
    tiles_total: 1,
    tiles_described: 0,
    describe_calls_saved: 1,
    approx_tokens_saved: 256,
    stale_tiles: 0,
  },
  state_path: 'x',
};

beforeEach(() => vi.clearAllMocks());

describe('handleDescribeScreenDelta scope', () => {
  it('refuses a mission that does not exist instead of inventing its directory', async () => {
    const describeDelta = vi.fn(async () => deltaResult);
    await expect(
      handleDescribeScreenDelta(
        { path: 'active/shared/tmp/screen.png', session_id: 's1', mission_id: 'MSN-NOPE' },
        { describeDelta, resolveMissionPath: () => null }
      )
    ).rejects.toThrow("[VISION_TIER_SCOPE] mission 'MSN-NOPE' does not exist");
    expect(describeDelta).not.toHaveBeenCalled();
  });

  it.each([
    ['session_id', { session_id: 'a/b' }, /SCREEN_DELTA_INVALID.*invalid session id/],
    ['mission_id', { session_id: 's1', mission_id: '../MSN-X' }, /invalid mission id/],
  ])('rejects a traversal-shaped %s', async (_name, extra, error) => {
    const describeDelta = vi.fn(async () => deltaResult);
    await expect(
      handleDescribeScreenDelta({ path: 'active/shared/tmp/screen.png', ...extra } as never, {
        describeDelta,
        resolveMissionPath: () => '/nowhere',
      })
    ).rejects.toThrow(error);
    expect(describeDelta).not.toHaveBeenCalled();
  });

  it('keeps tile memory in the mission directory for a mission-scoped call', async () => {
    const missionPath = path.join(pathResolver.rootDir(), 'active/missions/public/MSN-P');
    const describeDelta = vi.fn(async () => deltaResult);
    const result = await handleDescribeScreenDelta(
      { path: 'active/shared/tmp/screen.png', session_id: 's1', mission_id: 'MSN-P' },
      { describeDelta, resolveMissionPath: () => missionPath }
    );
    expect(result.tier).toBe('public');
    expect(describeDelta.mock.calls[0][1]).toEqual({
      work_dir: path.join(missionPath, 'tmp', 'vision-tiles'),
      state_dir: path.join(missionPath, 'tmp', 'vision-state'),
    });
  });

  it("refuses a tenant_slug that is not the mission's tenant", async () => {
    const missionPath = path.join(pathResolver.rootDir(), 'active/missions/public/MSN-P');
    const describeDelta = vi.fn(async () => deltaResult);
    await expect(
      handleDescribeScreenDelta(
        {
          path: 'active/shared/tmp/screen.png',
          session_id: 's1',
          mission_id: 'MSN-P',
          tenant_slug: 'acme',
        },
        {
          describeDelta,
          resolveMissionPath: () => missionPath,
          resolveMissionTenant: () => 'globex',
        }
      )
    ).rejects.toThrow("[VISION_TIER_SCOPE] tenant 'acme' does not own mission 'MSN-P'");
    expect(describeDelta).not.toHaveBeenCalled();
  });
});
