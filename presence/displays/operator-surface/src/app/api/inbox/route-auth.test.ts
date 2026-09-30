import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ accept: vi.fn(), mark: vi.fn() }));

vi.mock('@agent/core/deliverable-inbox', () => ({
  acceptInboxEntryWithHumanReceipt: mocks.accept,
  markInboxEntry: mocks.mark,
}));
vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route.js';

function post(headers: Record<string, string> = {}, ip?: string): NextRequest {
  const req = new NextRequest('http://ops.example/api/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ entry_id: 'INBOX-1', status: 'read' }),
  });
  if (ip) Object.defineProperty(req, 'ip', { value: ip });
  return req;
}

describe('operator-surface inbox POST authentication', () => {
  it('401 for a remote request with no credential', async () => {
    const res = await POST(post({ origin: 'http://ops.example' }));
    expect(res.status).toBe(401);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('401 for a remote request with a forged session cookie', async () => {
    const res = await POST(
      post({ origin: 'http://ops.example', cookie: 'kyberion_session=kys1.forged.sig' })
    );
    expect(res.status).toBe(401);
  });

  it('allows a same-origin loopback request exactly as before', async () => {
    mocks.mark.mockReturnValue({ entry_id: 'INBOX-1', status: 'read' });
    const res = await POST(post({ origin: 'http://ops.example' }, '127.0.0.1'));
    expect(res.status).toBe(303);
    expect(mocks.mark).toHaveBeenCalledWith('INBOX-1', 'read');
  });

  it('keeps the origin check for loopback (403 cross-origin)', async () => {
    const res = await POST(post({ origin: 'https://evil.example' }, '127.0.0.1'));
    expect(res.status).toBe(403);
  });
});
