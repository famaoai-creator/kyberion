import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Error shapes only; route.test.ts runs the real stores and authority layer.
const reads = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
const logs = vi.hoisted(() => ({ error: [] as string[] }));
vi.mock('@agent/core/logger', () => ({
  createLogger: () => ({
    error: (line: string) => logs.error.push(line),
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));
vi.mock('../../../lib/progress-server', () => ({
  readProgress: reads.list,
  readProgressDetail: reads.detail,
}));
vi.mock('../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/viewer-context')>()),
  resolveConciergeViewer: () => ({
    context: {
      role: 'readonly',
      tenantSlugs: ['alpha'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential', 'public'],
      source: 'token',
    },
  }),
}));

import { GET as list } from './route';
import { GET as detail } from './[id]/route';

function request(query = ''): NextRequest {
  return {
    headers: new Headers({ 'accept-language': 'ja' }),
    nextUrl: new URL(`http://127.0.0.1/api/progress${query}`),
  } as unknown as NextRequest;
}

beforeEach(() => {
  reads.list.mockReset();
  reads.detail.mockReset();
});

describe('concierge /api/progress error answers', () => {
  it('answers a store failure with a coded 500 and logs its cause under the same correlation id', async () => {
    logs.error.length = 0;
    reads.list.mockImplementation(() => {
      throw new Error('EACCES /private/path');
    });
    const response = list(request());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error_code: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('/private/path');
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]).toMatch(
      /^GET \/api\/progress read failed — EACCES \/private\/path \| next: .+ \| evidence: /
    );
    expect(logs.error[0]).toContain(`correlation_id=${body.correlation_id}`);
    expect(body.correlation_id).toMatch(/[0-9a-f-]{36}/);
  });

  it('refuses a narrowing outside the viewer scope before reading', async () => {
    const response = list(request('?tenant=beta'));
    expect(response.status).toBe(403);
    expect(reads.list).not.toHaveBeenCalled();
    const item = await detail(request('?tenant=beta'), { params: Promise.resolve({ id: 'x' }) });
    expect(item.status).toBe(403);
    expect(reads.detail).not.toHaveBeenCalled();
  });

  it('gives an unknown or malformed id the localized, coded 404', async () => {
    reads.detail.mockReturnValue(null);
    for (const id of ['TS-NOPE', 'bad\u0000id', '']) {
      const response = await detail(request(), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        error: 'この作業は表示できません。更新するか、別の作業を選んでください。',
        error_code: 'progress_item_unavailable',
      });
    }
    expect(reads.detail).toHaveBeenCalledTimes(1);
  });
});
