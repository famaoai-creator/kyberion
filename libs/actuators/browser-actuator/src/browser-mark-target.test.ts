import { afterEach, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { clearMarks, saveMarks } from '@agent/core/mark-target-resolver';
import {
  browserSnapshotId,
  isMarkTarget,
  resolveBrowserMarkTarget,
  type MarkResolver,
} from './browser-mark-target.js';

const sessions: string[] = [];
const SNAPSHOT = { tab_id: 'tab-1', captured_at: '2026-09-26T00:00:00.000Z' };
const SNAPSHOT_ID = 'tab-1@2026-09-26T00:00:00.000Z';

/** A flat page: its dHash is all zeros. */
async function flatPage(): Promise<Buffer> {
  return new Jimp({ data: Buffer.alloc(32 * 32 * 4, 128), width: 32, height: 32 }).getBuffer(
    'image/png'
  );
}

function domMark(extra: Record<string, unknown> = {}) {
  return vi.fn<MarkResolver>(async () => ({
    n: 3,
    marks_id: 'm1',
    x: 10,
    y: 20,
    ref: '@e7',
    label: 'Buy',
    dom_snapshot_id: SNAPSHOT_ID,
    ...extra,
  }));
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    safeRmSync(pathResolver.volatile('session', id), { recursive: true, force: true });
  }
});

describe('resolveBrowserMarkTarget', () => {
  it('recognises only mark:<n> targets and derives snapshot ids', () => {
    expect(isMarkTarget('mark:3')).toBe(true);
    expect(isMarkTarget('@e3')).toBe(false);
    expect(browserSnapshotId(SNAPSHOT)).toBe(SNAPSHOT_ID);
    expect(browserSnapshotId({ tab_id: 'tab-1' })).toBeUndefined();
  });

  it('maps a DOM-backed mark of the current snapshot to its @eN ref, verifying the page', async () => {
    const resolver = domMark();
    const target = await resolveBrowserMarkTarget(
      'mark:3',
      {
        params: { ref: 'mark:3', mark_session_id: 'vision-1', mark_scale: 2, marks_id: 'm1' },
        sessionId: 'browser-1',
        currentSnapshotId: SNAPSHOT_ID,
        captureScreen: flatPage,
      },
      resolver
    );
    expect(target).toMatchObject({ kind: 'ref', ref: '@e7' });
    expect(resolver).toHaveBeenCalledWith('mark:3', {
      session_id: 'vision-1',
      current_dhash: '0000000000000000',
      scale: 2,
      marks_id: 'm1',
    });
  });

  it.each([
    ['a different snapshot', { currentSnapshotId: 'tab-1@later' }, {}],
    [
      'marks without a snapshot id',
      { currentSnapshotId: SNAPSHOT_ID },
      { dom_snapshot_id: undefined },
    ],
    ['a session without a snapshot', {}, {}],
  ])('refuses a DOM mark from %s', async (_name, context, markExtra) => {
    await expect(
      resolveBrowserMarkTarget(
        'mark:3',
        { params: {}, sessionId: 's', captureScreen: flatPage, ...context },
        domMark(markExtra)
      )
    ).rejects.toThrow(/^\[MARK_STALE\] mark 3 refers to @e7/);
  });

  it('refuses when the page cannot be captured, before resolving', async () => {
    const resolver = domMark();
    await expect(
      resolveBrowserMarkTarget(
        'mark:3',
        {
          params: {},
          sessionId: 's',
          currentSnapshotId: SNAPSHOT_ID,
          captureScreen: async () => {
            throw new Error('page closed');
          },
        },
        resolver
      )
    ).rejects.toThrow(/^\[MARK_STALE\] cannot capture the page/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([{ high_risk: true }, { dom_path: 'body > button' }, { role: 'button' }])(
    'refuses a point mark when the click needs corroboration (%j)',
    async (params) => {
      const resolver = vi.fn<MarkResolver>(async () => ({ n: 1, marks_id: 'm1', x: 5, y: 6 }));
      await expect(
        resolveBrowserMarkTarget(
          'mark:1',
          { params, sessionId: 's', captureScreen: flatPage },
          resolver
        )
      ).rejects.toThrow(/^\[MARK_INVALID\] mark 1 is a bare point/);
    }
  );

  it('maps a pixel-only mark to a CSS-pixel point once the page matches', async () => {
    const id = `browser-mark-target-${process.pid}`;
    sessions.push(id);
    clearMarks(id);
    saveMarks({
      session_id: id,
      image: { width: 2560, height: 1600 },
      image_dhash: '0000000000000000',
      scale: 2,
      marks: [
        {
          n: 1,
          box: { x: 400, y: 200, width: 100, height: 40 },
          center: { x: 450, y: 220 },
          kind: 'text',
          label: 'Checkout',
          sources: ['ocr'],
        },
      ],
    });
    const input = { params: {}, sessionId: id, captureScreen: flatPage };
    await expect(resolveBrowserMarkTarget('mark:1', input)).resolves.toMatchObject({
      kind: 'point',
      x: 225,
      y: 110,
    });
    await expect(resolveBrowserMarkTarget('mark:2', input)).rejects.toThrow(/^\[MARK_STALE\]/);
  });
});
