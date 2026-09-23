import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const fixture = vi.hoisted(() => ({ viewer: undefined as unknown }));
vi.mock('../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/viewer-context')>(
    '../../../../lib/viewer-context'
  );
  return { ...actual, resolveConciergeViewer: vi.fn(() => fixture.viewer) };
});

import { GET } from './route';
import { AGENT_AVATAR_SOURCES } from '../../../../lib/agent-avatar-sources';

const req = {} as NextRequest;
const params = (expression: string) => ({ params: Promise.resolve({ expression }) });

describe('concierge GET /api/agent-avatar/[expression] (PA-09 default dock avatar)', () => {
  it('serves every allow-listed product SVG to a resolved viewer', async () => {
    fixture.viewer = { context: { role: 'readonly', source: 'token' } };
    for (const expression of Object.keys(AGENT_AVATAR_SOURCES)) {
      const res = await GET(req, params(expression));
      expect(res.status, expression).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toContain('<svg');
    }
  });

  it.each(['../secret', 'mouth_open', 'kyberion-neutral.svg', '__proto__'])(
    'rejects %s outside the allow-list',
    async (expression) => {
      fixture.viewer = { context: { role: 'localadmin', source: 'loopback' } };
      expect((await GET(req, params(expression))).status).toBe(404);
    }
  );

  it('returns the viewer rejection unchanged', async () => {
    const denied = new Response(null, { status: 401 });
    fixture.viewer = { response: denied };
    expect(await GET(req, params('neutral'))).toBe(denied);
  });
});
