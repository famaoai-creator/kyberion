import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalResponseFailure,
  formatApprovalFailure,
  readApprovalResponseFailure,
} from './approval-failure';

const privateDetail = '/private/server/path token=synthetic-secret <script>private-stack</script>';
afterEach(() => vi.useRealTimers());

describe('approval failure display boundary', () => {
  it.each([
    'busy',
    'session_locked',
    'not_found',
    'invalid_request',
    'not_implemented',
    'internal',
  ])('displays only the allowed %s code and HTTP status, never body details', async (code) => {
    const response = Response.json(
      {
        error_code: code,
        error: privateDetail,
        stack: privateDetail,
        correlation_id: privateDetail,
      },
      { status: 500 }
    );
    const error = await readApprovalResponseFailure(response);
    for (const locale of ['en', 'ja'] as const) {
      const notice = formatApprovalFailure(error, locale);
      expect(notice).toContain(`HTTP 500; ${code}`);
      expect(notice).not.toContain(privateDetail);
      expect(notice).not.toContain('private-stack');
    }
  });

  it.each([
    null,
    false,
    'private-detail',
    [],
    { code: 'internal', error: privateDetail },
    { error_code: privateDetail },
    { error_code: 'INTERNAL' },
    { error_code: { toString: () => privateDetail } },
    Object.create({ error_code: 'internal' }),
    JSON.parse('{"__proto__":{"error_code":"internal"},"constructor":"private-detail"}'),
  ])('ignores unknown codes and malformed payloads %#', (payload) => {
    const notice = formatApprovalFailure(approvalResponseFailure(502, payload), 'en');
    expect(notice).toContain('HTTP 502; request_failed');
    expect(notice).not.toContain('private');
  });

  it.each([
    [401, 'Sign-in could not be verified'],
    [403, 'not permitted'],
    [404, 'no longer available'],
    [410, 'no longer available'],
    [429, 'busy or locked'],
    [400, 'could not be accepted'],
    [422, 'could not be accepted'],
    [408, 'could not be confirmed'],
    [504, 'could not be confirmed'],
    [503, 'could not be confirmed'],
  ] as const)('has safe guidance for HTTP %s without a wire code', (status, guidance) => {
    const notice = formatApprovalFailure(
      approvalResponseFailure(status, { error: privateDetail }),
      'en'
    );
    expect(notice).toContain(`HTTP ${status}; request_failed`);
    expect(notice).toContain(guidance);
    expect(notice).not.toContain(privateDetail);
  });

  it.each(['<html>private-stack</html>', '{invalid-json', '', 'null', '[]'])(
    'handles non-object or non-JSON responses without exposing them: %s',
    async (body) => {
      const error = await readApprovalResponseFailure(new Response(body, { status: 502 }));
      expect(formatApprovalFailure(error, 'en')).toContain('HTTP 502; request_failed');
      expect(formatApprovalFailure(error, 'en')).not.toContain('private-stack');
    }
  );

  it('keeps the HTTP status if reading the response body times out', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException(privateDetail, 'TimeoutError'));
        },
      }),
      { status: 504 }
    );
    const notice = formatApprovalFailure(await readApprovalResponseFailure(response), 'en');
    expect(notice).toContain('HTTP 504; request_failed');
    expect(notice).not.toContain(privateDetail);
    expect(response.body?.locked).toBe(false);
  });

  it('bounds a never-ending diagnostic body and releases its reader without waiting for cancel', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error_code":'));
        },
        cancel,
      }),
      { status: 500 }
    );
    const pending = readApprovalResponseFailure(response);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = formatApprovalFailure(await pending, 'en');
    expect(notice).toContain('HTTP 500; request_failed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards oversized error bodies and cancels consumption at the byte cap', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                error_code: 'internal',
                error: privateDetail.repeat(100),
              })
            )
          );
        },
        cancel,
      }),
      { status: 502 }
    );
    const notice = formatApprovalFailure(await readApprovalResponseFailure(response), 'en');
    expect(notice).toContain('HTTP 502; request_failed');
    expect(notice).not.toContain(privateDetail);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('clears the timeout and unlocks a successfully parsed diagnostic body', async () => {
    vi.useFakeTimers();
    const response = Response.json({ error_code: 'invalid_request' }, { status: 403 });
    expect(formatApprovalFailure(await readApprovalResponseFailure(response), 'en')).toContain(
      'HTTP 403; invalid_request'
    );
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new TypeError(privateDetail),
    new DOMException(privateDetail, 'TimeoutError'),
    new DOMException(privateDetail, 'AbortError'),
    new DOMException(privateDetail, 'NotAllowedError'),
    new Error(privateDetail),
    privateDetail,
    { message: privateDetail, status: 403, error_code: 'internal' },
    null,
    undefined,
  ])('keeps arbitrary transport/passkey/refresh failures unconfirmed and private %#', (error) => {
    const notice = formatApprovalFailure(error, 'en');
    expect(notice).toContain('result_unconfirmed');
    expect(notice).toContain('check its status before trying again');
    expect(notice).not.toContain('HTTP');
    expect(notice).not.toContain(privateDetail);
  });

  it.each([NaN, Infinity, 0, 200, 399, 600, 403.5])(
    'never displays invalid status %s',
    (status) => {
      expect(formatApprovalFailure(approvalResponseFailure(status, null), 'en')).not.toContain(
        'HTTP'
      );
    }
  );
});
