import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const fixture = vi.hoisted(() => ({ root: '', viewer: undefined as unknown }));
vi.mock('@agent/core/profile-root', () => ({ resolveActiveProfileRoot: () => fixture.root }));
vi.mock('../../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../../lib/viewer-context')>(
    '../../../../../lib/viewer-context'
  );
  return { ...actual, resolveConciergeViewer: vi.fn(() => fixture.viewer) };
});

import { GET } from './route';
import { GET as describeGet } from '../route';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
const viewer = (source: 'loopback' | 'token', role: 'localadmin' | 'readonly') => ({
  context: {
    role,
    source,
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
  },
});
const req = {} as NextRequest;
const params = (expression: string) => ({ params: Promise.resolve({ expression }) });

describe('concierge GET /api/me/avatar/[expression]', () => {
  beforeEach(() => {
    fixture.root = pathResolver.sharedTmp(`concierge-avatar-${process.pid}`);
    fixture.viewer = viewer('loopback', 'localadmin');
    const dir = path.join(fixture.root, 'avatar');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'neutral.png'), PNG);
    safeWriteFile(
      path.join(dir, 'avatar-profile.json'),
      JSON.stringify({ version: 1, images: { neutral: 'neutral.png' } })
    );
  });
  afterEach(() => safeRmSync(fixture.root, { recursive: true, force: true }));

  it('serves a frame to the loopback owner as an uncached image', async () => {
    const res = await GET(req, params('neutral'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it.each([
    ['token localadmin', viewer('token', 'localadmin')],
    ['token readonly', viewer('token', 'readonly')],
  ])('denies a %s viewer', async (_label, value) => {
    fixture.viewer = value;
    const res = await GET(req, params('neutral'));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it.each(['../my-identity', 'avatar-profile', 'neutral.png', '..%2Fsecret'])(
    'rejects %s outside the allow-list',
    async (expression) => {
      const res = await GET(req, params(expression));
      expect(res.status).toBe(404);
    }
  );

  it('returns 404 for a missing frame and describes the set for the owner', async () => {
    expect((await GET(req, params('joy'))).status).toBe(404);
    const described = await (await describeGet(req)).json();
    expect(described).toMatchObject({
      ok: true,
      avatar: { images: { neutral: '/api/me/avatar/neutral' }, adopted: false },
    });
  });

  it('serves the draft set only with ?set=draft', async () => {
    const draft = path.join(fixture.root, 'avatar', 'draft');
    safeMkdir(draft, { recursive: true });
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);
    safeWriteFile(path.join(draft, 'joy.png'), JPEG);
    safeWriteFile(path.join(draft, 'neutral.png'), JPEG);
    safeWriteFile(
      path.join(draft, 'avatar-profile.json'),
      JSON.stringify({ version: 1, images: { neutral: 'neutral.png', joy: 'joy.png' } })
    );
    const draftReq = {
      nextUrl: new URL('http://127.0.0.1/api/me/avatar/joy?set=draft'),
    } as unknown as NextRequest;
    expect((await GET(req, params('joy'))).status).toBe(404);
    const res = await GET(draftReq, params('joy'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const described = await (await describeGet(draftReq)).json();
    expect(described.avatar).toMatchObject({
      images: { joy: '/api/me/avatar/joy?set=draft' },
      adopted: false,
      set: 'draft',
    });
  });
});
