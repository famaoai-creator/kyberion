import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import type { DescribeImageOptions } from '@agent/core/image-description-bridge';
import { handleDescribeImage } from './describe-image.js';

const succeeded = {
  status: 'succeeded' as const,
  provider: 'reasoning_vision',
  description: 'A chart.',
  elapsedMs: 1,
};

function recorder() {
  const seen: DescribeImageOptions[] = [];
  const describeFn = vi.fn(async (_request: unknown, options: DescribeImageOptions) => {
    seen.push(options);
    return succeeded;
  });
  return { describeFn, seen };
}

describe('handleDescribeImage', () => {
  it('sends only a redacted copy for a public image and passes the tenant', async () => {
    const { describeFn, seen } = recorder();
    const redactCopy = vi.fn(async () => ({ path: '/redacted.png', dispose: () => {} }));
    const result = await handleDescribeImage(
      { path: 'active/shared/tmp/chart.png', kind: 'diagram', tenant_slug: 'acme' },
      { describe: describeFn, redactCopy }
    );
    expect(result).toEqual({
      status: 'succeeded',
      path: 'active/shared/tmp/chart.png',
      description: 'A chart.',
      provider: 'reasoning_vision',
    });
    expect(describeFn).toHaveBeenCalledWith(
      { path: 'active/shared/tmp/chart.png', kind: 'diagram' },
      expect.objectContaining({ tier: 'public', tenant_slug: 'acme' })
    );
    await expect(seen[0].prepare_egress_image?.('/abs/chart.png')).resolves.toMatchObject({
      path: '/redacted.png',
    });
    expect(redactCopy).toHaveBeenCalledWith('/abs/chart.png', {});
  });

  it('redacts a mission image inside the mission under the mission tier', async () => {
    const { describeFn, seen } = recorder();
    const missionPath = path.join(pathResolver.rootDir(), 'active/missions/confidential/MSN-D');
    const redactCopy = vi.fn(async () => ({ path: '/redacted.png', dispose: () => {} }));
    await handleDescribeImage(
      { path: 'active/shared/tmp/chart.png', mission_id: 'MSN-D' },
      { describe: describeFn, redactCopy, resolveMissionPath: () => missionPath }
    );
    expect(seen[0].tier).toBe('confidential');
    await seen[0].prepare_egress_image?.('/abs/chart.png');
    expect(redactCopy).toHaveBeenCalledWith('/abs/chart.png', {
      work_dir: path.join(missionPath, 'tmp', 'vision-describe'),
    });
  });

  it('refuses a non-public image without a mission before describing it', async () => {
    const { describeFn } = recorder();
    await expect(
      handleDescribeImage(
        { path: 'active/missions/confidential/MSN-X/evidence/shot.png' },
        { describe: describeFn }
      )
    ).rejects.toThrow('[VISION_TIER_SCOPE] confidential image description needs mission_id');
    await expect(
      handleDescribeImage(
        { path: 'active/shared/tmp/chart.png', tier: 'personal' },
        { describe: describeFn }
      )
    ).rejects.toThrow('[VISION_TIER_SCOPE] personal');
    expect(describeFn).not.toHaveBeenCalled();
  });
});
