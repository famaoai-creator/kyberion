/**
 * (error, status override) -> (status, error_code) for the one viewer error
 * helper, on both paths: `conciergeErrorResponse` (Concierge routes) and
 * `viewerErrorResponse` (operations console). Each row says whether it equals
 * origin/main before the two helpers were unified; the rows that differ are
 * the intended status changes only.
 */
import { describe, expect, it } from 'vitest';
import { SurfaceAuthorizationError } from '@agent/core/surface/surface-authorization';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { DotLifecycleDispatchError } from './ops/dot-lifecycle-dispatch';
import { viewerErrorResponse } from './ops/ops-viewer';
import { ConciergeViewerError, conciergeErrorResponse } from './viewer-context';

const plain = () => new Error('boom');
const viewer403 = () => new ConciergeViewerError(403, 'viewer tenant scope denied: other');
const scope401 = () => new SurfaceViewerScopeError(401, 'Unknown viewer token.');
const scope403 = () => new SurfaceViewerScopeError(403, 'viewer tenant scope denied: other');
const operationDenied = () =>
  new SurfaceAuthorizationError({
    allowed: false,
    operationId: 'x.read',
    reasonCode: 'tier_scope_denied',
    reason: 'tier scope denied for x.read',
    policyId: 'surface:x.read',
  });
const errnoBusy = () => Object.assign(new Error('write failed'), { code: 'EBUSY' });
const sessionLocked = () => Object.assign(new Error('write failed'), { code: 'session_locked' });
const lifecycleConflict = () => new DotLifecycleDispatchError('DOT lifecycle changed', true);

type Row = [
  name: string,
  error: () => unknown,
  override: number | undefined,
  status: number,
  code: string,
];

// Concierge routes: the code follows the response status (and the message).
const CONCIERGE: Row[] = [
  ['plain Error', plain, undefined, 500, 'internal'], // = origin/main
  ['plain Error, 400', plain, 400, 400, 'invalid_request'], // = origin/main
  ['plain Error, 404', plain, 404, 404, 'not_found'], // = origin/main
  ['plain Error, 409', plain, 409, 409, 'busy'], // = origin/main
  ['ConciergeViewerError(403)', viewer403, undefined, 403, 'invalid_request'], // = origin/main
  // INTENDED CHANGE: origin/main answered 500 / internal (the code follows the status).
  ['SurfaceViewerScopeError(401)', scope401, undefined, 401, 'invalid_request'],
  // INTENDED CHANGE: origin/main answered 500 (code invalid_request, from "denied").
  ['SurfaceViewerScopeError(403)', scope403, undefined, 403, 'invalid_request'],
  // INTENDED CHANGE: origin/main answered 500 (code invalid_request, from "denied").
  ['SurfaceAuthorizationError', operationDenied, undefined, 403, 'invalid_request'],
  ['errno EBUSY', errnoBusy, undefined, 500, 'internal'], // = origin/main (error.code is not read)
  ['code session_locked', sessionLocked, undefined, 500, 'internal'], // = origin/main
  ['lifecycle conflict, 409', lifecycleConflict, 409, 409, 'busy'], // = origin/main
];

// Operations console: the code is the error's own, whatever status is answered.
const OPS: Row[] = [
  ['plain Error', plain, undefined, 403, 'internal'], // = origin/main
  ['plain Error, 400', plain, 400, 400, 'internal'], // = origin/main
  ['plain Error, 404', plain, 404, 404, 'internal'], // = origin/main
  ['plain Error, 409', plain, 409, 409, 'internal'], // = origin/main
  ['ConciergeViewerError(403)', viewer403, undefined, 403, 'invalid_request'], // = origin/main
  // INTENDED CHANGE: origin/main answered 403 (same code).
  ['SurfaceViewerScopeError(401)', scope401, undefined, 401, 'invalid_request'],
  ['SurfaceViewerScopeError(403)', scope403, undefined, 403, 'invalid_request'], // = origin/main
  ['SurfaceAuthorizationError', operationDenied, undefined, 403, 'invalid_request'], // = origin/main
  ['errno EBUSY', errnoBusy, undefined, 403, 'busy'], // = origin/main
  ['code session_locked', sessionLocked, undefined, 403, 'session_locked'], // = origin/main
  // = origin/main: a lifecycle conflict answered 409 is not reported as "server busy".
  ['lifecycle conflict, 409', lifecycleConflict, 409, 409, 'internal'],
];

describe('viewer error response: (error, override) -> (status, error_code)', () => {
  it.each(CONCIERGE)('Concierge route: %s', async (_name, error, override, status, code) => {
    const response = conciergeErrorResponse(error(), override);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error_code: code });
  });

  it.each(OPS)('operations console: %s', async (_name, error, override, status, code) => {
    const response = viewerErrorResponse(error(), override);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error_code: code });
  });

  it('never puts the error message on the wire', async () => {
    for (const respond of [conciergeErrorResponse, viewerErrorResponse]) {
      const body = await respond(new Error('secret path /private/x')).json();
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(body.correlation_id).toEqual(expect.any(String));
    }
  });
});
