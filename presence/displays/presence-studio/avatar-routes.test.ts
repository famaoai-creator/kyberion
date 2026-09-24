// PA-10: personal avatar asset routes — same fake-app pattern as
// training-routes.test.ts. The profile root is redirected to a shared-tmp
// fixture so no real personal-tier file is read.
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('@agent/core/profile-root', () => ({ resolveActiveProfileRoot: () => fixture.root }));

import { registerAvatarRoutes } from './avatar-routes.js';

type Handler = (req: unknown, res: unknown) => void;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);

function createFakeApp() {
  const handlers = new Map<string, Handler>();
  const fake = {
    get(routePath: string, handler: Handler) {
      handlers.set(`GET ${routePath}`, handler);
    },
  };
  registerAvatarRoutes(fake as unknown as import('express').Express);
  return handlers;
}

function fakeRequest(expression: string | undefined, remoteAddress = '127.0.0.1', auth?: string) {
  const urlPath = `/api/me/avatar${expression === undefined ? '' : `/${expression}`}`;
  return {
    params: expression === undefined ? {} : { expression },
    query: {},
    headers: auth ? { authorization: auth } : {},
    socket: { remoteAddress },
    path: urlPath,
    originalUrl: urlPath,
    url: urlPath,
  } as never;
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return res;
}

describe('presence-studio /api/me/avatar', () => {
  beforeEach(() => {
    fixture.root = pathResolver.sharedTmp(`presence-studio-avatar-${process.pid}`);
    const dir = path.join(fixture.root, 'avatar');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'neutral.png'), PNG);
    safeWriteFile(
      path.join(dir, 'avatar-profile.json'),
      JSON.stringify({
        version: 1,
        images: { neutral: 'neutral.png' },
        mouth: { x: 0.5, y: 0.6, width: 0.2 },
      })
    );
    safeWriteFile(path.join(fixture.root, 'my-identity.json'), JSON.stringify({ name: 'secret' }));
  });
  afterEach(() => safeRmSync(fixture.root, { recursive: true, force: true }));

  it('serves an allow-listed frame to the loopback owner with no-store + image type', () => {
    const res = fakeResponse();
    createFakeApp().get('GET /api/me/avatar/:expression')!(fakeRequest('neutral'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(PNG);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('describes the set in the ui:talking-avatar shape', () => {
    const res = fakeResponse();
    createFakeApp().get('GET /api/me/avatar')!(fakeRequest(undefined), res);
    expect(res.body).toMatchObject({
      ok: true,
      avatar: {
        images: { neutral: '/api/me/avatar/neutral' },
        mouth: { x: 0.5, y: 0.6, width: 0.2 },
      },
    });
  });

  it.each(['../my-identity', 'my-identity.json', 'avatar-profile', 'neutral.png', '%2e%2e'])(
    'rejects %s outside the expression allow-list',
    (expression) => {
      const res = fakeResponse();
      createFakeApp().get('GET /api/me/avatar/:expression')!(fakeRequest(expression), res);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toBeUndefined();
    }
  );

  it('returns 404 for an allow-listed but missing frame', () => {
    const res = fakeResponse();
    createFakeApp().get('GET /api/me/avatar/:expression')!(fakeRequest('joy'), res);
    expect(res.statusCode).toBe(404);
  });

  it('denies a remote request (no personal-tier access)', () => {
    const res = fakeResponse();
    createFakeApp().get('GET /api/me/avatar/:expression')!(
      fakeRequest('neutral', '203.0.113.9', 'Bearer not-the-token'),
      res
    );
    expect([401, 403]).toContain(res.statusCode);
    expect(res.body).not.toEqual(PNG);
  });

  it('is registered from server.ts and never through express.static', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/presence-studio/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('registerAvatarRoutes(presenceStudioData.app)');
    const routes = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/presence-studio/avatar-routes.ts'), {
        encoding: 'utf8',
      })
    );
    expect(routes).not.toMatch(/express\.static\(/);
  });
});
