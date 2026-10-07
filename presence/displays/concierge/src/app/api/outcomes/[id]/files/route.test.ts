import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ viewer: vi.fn(), list: vi.fn(), read: vi.fn() }));
vi.mock('../../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: mocks.viewer,
  ConciergeViewerError: class extends Error {
    status = 403;
  },
}));
vi.mock('../../../../../lib/outcome-files', async (original) => {
  const actual = await original<typeof import('../../../../../lib/outcome-files')>();
  return { ...actual, listOutcomeFiles: mocks.list, readOutcomeFile: mocks.read };
});
import { GET as list } from './route';
import { GET as download } from './[fileId]/route';
import { OutcomeFileError } from '../../../../../lib/outcome-files';
const params = () => ({ params: Promise.resolve({ id: 'INBOX-TEST', fileId: 'a'.repeat(128) }) });
const req = (path = '') => new NextRequest('http://localhost/api/outcomes/INBOX-TEST/files' + path);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewer.mockReturnValue({ context: { principalId: 'user:alice' } });
  mocks.list.mockImplementation((reader) => {
    reader();
    reader();
    return { entry_id: 'INBOX-TEST', total: 0, offset: 0, files: [] };
  });
  mocks.read.mockImplementation((reader) => {
    reader();
    reader();
    return { bytes: Buffer.from([0, 255, 12]), name: 'report.pdf', contentType: 'application/pdf' };
  });
});
describe('readonly outcome files HTTP routes', () => {
  it('lists only through the authenticated reader, refreshed again before delivery', async () => {
    const result = await list(req(), params());
    expect(result.status).toBe(200);
    expect(mocks.viewer).toHaveBeenCalledTimes(2);
    expect(result.headers.get('cache-control')).toContain('no-store');
  });
  it('returns exactly verified binary bytes as a safe attachment', async () => {
    const result = await download(req('/' + 'a'.repeat(128)), params());
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255, 12]);
    expect(result.headers.get('content-type')).toBe('application/pdf');
    expect(result.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('content-security-policy')).toContain('sandbox');
    expect(result.headers.get('content-length')).toBe('3');
  });
  it.each(['?path=/etc/passwd', '?tenant=other', '?cursor=a&cursor=b'])(
    'rejects unapproved list input %s',
    async (query) => {
      expect((await list(req(query), params())).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );
  it('never accepts a client pathname on the download route', async () => {
    expect((await download(req('/' + 'a'.repeat(128) + '?path=report.pdf'), params())).status).toBe(
      400
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('preserves authentication failure and fails closed on mid-request revocation', async () => {
    mocks.viewer
      .mockReturnValueOnce({ context: { principalId: 'user:alice' } })
      .mockReturnValueOnce({ response: NextResponse.json({ ok: false }, { status: 401 }) });
    const result = await download(req(), params());
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it.each([403, 404, 409, 413] as const)(
    'reports denied/stale/missing/oversized files safely: %s',
    async (status) => {
      mocks.read.mockImplementation(() => {
        throw new OutcomeFileError(status, '/private/secret-path');
      });
      const result = await download(req(), params());
      expect(result.status).toBe(status);
      expect(await result.text()).not.toContain('secret-path');
    }
  );
});
