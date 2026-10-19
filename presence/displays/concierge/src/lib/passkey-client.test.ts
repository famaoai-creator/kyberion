import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideWithPasskey } from './passkey-client';
import { formatApprovalFailure } from './approval-failure';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), authenticate: vi.fn() }));
vi.mock('./front-desk-fetch', () => ({ frontDeskFetch: mocks.fetch }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: mocks.authenticate,
  startRegistration: vi.fn(),
}));

const input = {
  requestId: 'approval/id',
  decision: 'approved' as const,
  channel: 'tenant-provider-attestation',
  storageChannel: 'tenant-provider-attestation',
  presentedDigest: 'fresh-synthetic-digest',
};
const privateDetail = '/private/server/path token=synthetic-secret';
const success = (data: Record<string, unknown>) => Response.json({ ok: true, ...data });

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('passkey approval failure display without resubmission', () => {
  it('preserves the two successful POSTs and their digest/challenge bindings', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        success({ options: { challenge: 'fixture' }, challenge_id: 'bound-challenge' })
      )
      .mockResolvedValueOnce(success({}));
    mocks.authenticate.mockResolvedValue({ id: 'signed-assertion' });
    await decideWithPasskey(input);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [start, verify] = mocks.fetch.mock.calls;
    for (const call of [start, verify]) {
      expect(call[0]).toBe('/api/approvals/approval%2Fid/passkey');
      expect(call[1]).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    }
    expect(JSON.parse(start[1].body)).toEqual({
      decision: input.decision,
      channel: input.channel,
      storageChannel: input.storageChannel,
      action: 'options',
      presentedDigest: input.presentedDigest,
    });
    expect(JSON.parse(verify[1].body)).toEqual({
      decision: input.decision,
      channel: input.channel,
      storageChannel: input.storageChannel,
      action: 'verify',
      challengeId: 'bound-challenge',
      response: { id: 'signed-assertion' },
    });
  });

  it.each([401, 403, 500])(
    'does not call the authenticator or retry rejected options (%s)',
    async (status) => {
      mocks.fetch.mockResolvedValue(
        Response.json({ error_code: 'invalid_request', error: privateDetail }, { status })
      );
      const error = await decideWithPasskey(input).catch((value: unknown) => value);
      const notice = formatApprovalFailure(error, 'en');
      expect(notice).toContain(`HTTP ${status}; invalid_request`);
      expect(notice).not.toContain(privateDetail);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.authenticate).not.toHaveBeenCalled();
    }
  );

  it('does not retry a rejected verify, including an HTML gateway failure', async () => {
    mocks.fetch
      .mockResolvedValueOnce(success({ options: {}, challenge_id: 'bound-challenge' }))
      .mockResolvedValueOnce(new Response(`<html>${privateDetail}</html>`, { status: 502 }));
    mocks.authenticate.mockResolvedValue({ id: 'signed-assertion' });
    const error = await decideWithPasskey(input).catch((value: unknown) => value);
    const notice = formatApprovalFailure(error, 'en');
    expect(notice).toContain('HTTP 502; request_failed');
    expect(notice).not.toContain(privateDetail);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  });

  it('never sends verify after a cancelled authenticator', async () => {
    mocks.fetch.mockResolvedValueOnce(success({ options: {}, challenge_id: 'bound-challenge' }));
    mocks.authenticate.mockRejectedValue(new DOMException(privateDetail, 'NotAllowedError'));
    const error = await decideWithPasskey(input).catch((value: unknown) => value);
    expect(formatApprovalFailure(error, 'en')).toContain('result_unconfirmed');
    expect(formatApprovalFailure(error, 'en')).not.toContain(privateDetail);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries a timed-out transport', async () => {
    mocks.fetch.mockRejectedValue(new DOMException(privateDetail, 'TimeoutError'));
    const error = await decideWithPasskey(input).catch((value: unknown) => value);
    expect(formatApprovalFailure(error, 'en')).toContain('result_unconfirmed');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled non-2xx passkey options without authenticating or retrying', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 502 });
    mocks.fetch.mockResolvedValue(response);
    const pending = decideWithPasskey(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(formatApprovalFailure(await pending, 'en')).toContain('HTTP 502; request_failed');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still refuses a missing presented digest before any request', async () => {
    const error = await decideWithPasskey({ ...input, presentedDigest: undefined }).catch(
      (value: unknown) => value
    );
    expect(formatApprovalFailure(error, 'en')).toContain('result_unconfirmed');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
});
