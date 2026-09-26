import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { clearMarks, saveMarks } from '@agent/core/mark-target-resolver';
import {
  isMarkTarget,
  resolveBrowserMarkTarget,
  type MarkResolver,
} from './browser-mark-target.js';

const sessions: string[] = [];

afterEach(() => {
  for (const id of sessions.splice(0)) {
    safeRmSync(pathResolver.volatile('session', id), { recursive: true, force: true });
  }
});

describe('resolveBrowserMarkTarget', () => {
  it('recognises only mark:<n> targets', () => {
    expect(isMarkTarget('mark:3')).toBe(true);
    expect(isMarkTarget('@e3')).toBe(false);
  });

  it('maps a DOM-backed mark to its @eN ref and passes session, scale and marks_id', async () => {
    const resolver = vi.fn<MarkResolver>(async () => ({
      n: 3,
      marks_id: 'm1',
      x: 10,
      y: 20,
      ref: '@e7',
      label: 'Buy',
    }));
    const target = await resolveBrowserMarkTarget(
      'mark:3',
      {
        params: { ref: 'mark:3', mark_session_id: 'vision-1', mark_scale: 2, marks_id: 'm1' },
        sessionId: 'browser-1',
      },
      resolver
    );
    expect(target).toMatchObject({ kind: 'ref', ref: '@e7' });
    expect(resolver).toHaveBeenCalledWith('mark:3', {
      session_id: 'vision-1',
      scale: 2,
      marks_id: 'm1',
    });
  });

  it('maps a pixel-only mark to a CSS-pixel point using the stored scale', async () => {
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
    await expect(
      resolveBrowserMarkTarget('mark:1', { params: {}, sessionId: id })
    ).resolves.toMatchObject({ kind: 'point', x: 225, y: 110 });
    await expect(resolveBrowserMarkTarget('mark:2', { params: {}, sessionId: id })).rejects.toThrow(
      /^\[MARK_STALE\]/
    );
  });
});
