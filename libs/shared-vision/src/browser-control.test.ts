import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import {
  BROWSER_BRIDGE_MAILBOX_ROOT,
  BROWSER_CONTROL_SECRET_ROOT,
  enqueueBrowserBridgeRequest,
  loadBrowserBridgeRequest,
  readBrowserControlSecrets,
  respondBrowserBridgeRequest,
  type BrowserBridgeControlStepPayload,
} from './browser-bridge-mailbox.js';
import {
  BROWSER_CONTROL_SESSION_ROOT,
  admitControlStep,
  hashControlStep,
  listBrowserControlSessions,
  loadBrowserControlSession,
  mintBrowserControlSession,
  recordApprovedControlStep,
  revokeBrowserControlSession,
} from './browser-control-sessions.js';

const SESSION_ROOT = pathResolver.rootResolve(BROWSER_CONTROL_SESSION_ROOT);
const SECRET_ROOT = pathResolver.rootResolve(BROWSER_CONTROL_SECRET_ROOT);
const MAILBOX_ROOT = pathResolver.rootResolve(BROWSER_BRIDGE_MAILBOX_ROOT);
const T0 = new Date('2026-11-22T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

afterEach(() => {
  safeRmSync(SESSION_ROOT, { recursive: true, force: true });
  safeRmSync(SECRET_ROOT, { recursive: true, force: true });
  safeRmSync(MAILBOX_ROOT, { recursive: true, force: true });
});

function mint(overrides: Parameters<typeof mintBrowserControlSession>[0] = {}) {
  return mintBrowserControlSession({
    origin: 'https://api.slack.com',
    requested_by: { actor_id: 'agent:test', mission_id: 'MSN-TEST-1' },
    approval_request_id: 'APR-TEST-1',
    now: T0,
    ...overrides,
  });
}

function controlPayload(
  session: ReturnType<typeof mint>,
  step: Partial<BrowserBridgeControlStepPayload['step']> = {}
): BrowserBridgeControlStepPayload {
  return {
    session_id: session.session_id,
    lease_id: session.lease_id,
    origin: session.origin,
    step: { step_id: 't-1', op: 'click_ref', ref: 'e12', ...step },
  };
}

function enqueueStep(session: ReturnType<typeof mint>, step = {}) {
  return enqueueBrowserBridgeRequest(
    {
      request_kind: 'control_step',
      payload: controlPayload(session, step),
      requested_by: { actor_id: 'agent:test' },
      scope: { tier: 'personal' },
    },
    { now: T0, assertTenant: () => undefined }
  );
}

describe('browser control sessions', () => {
  it('mints an active session bound to an origin and admits a low-risk step', () => {
    const session = mint();
    expect(session.status).toBe('active');
    const admission = admitControlStep(session.session_id, { op: 'click_ref' }, at(1));
    expect(admission.ok).toBe(true);
    if (admission.ok) expect(admission.session.origin).toBe('https://api.slack.com');
  });

  it('expires sessions past their ttl and revokes on demand', () => {
    const session = mint({ ttl_ms: 60_000 });
    const expired = admitControlStep(session.session_id, { op: 'snapshot' }, at(61_000));
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe('expired');
    expect(loadBrowserControlSession(session.session_id)?.status).toBe('expired');

    const live = mint({ ttl_ms: 60_000 });
    revokeBrowserControlSession(live.session_id);
    const denied = admitControlStep(live.session_id, { op: 'snapshot' });
    expect(denied.ok === false && denied.reason === 'revoked').toBe(true);
  });

  it('observe-ceiling sessions admit reads but deny interaction', () => {
    const session = mint({ risk_ceiling: 'observe' });
    expect(admitControlStep(session.session_id, { op: 'snapshot' }, at(1)).ok).toBe(true);
    const denied = admitControlStep(session.session_id, { op: 'click_ref' }, at(1));
    expect(denied.ok === false && denied.reason === 'above_ceiling').toBe(true);
  });

  it('high-risk ops require an approved step hash before admission', () => {
    const session = mint();
    const step = { op: 'submit_form', step_id: 't-9', ref: 'e3' };
    const denied = admitControlStep(session.session_id, step, at(1));
    expect(denied.ok === false && denied.reason === 'approval_required').toBe(true);

    recordApprovedControlStep(session.session_id, step);
    const admitted = admitControlStep(session.session_id, step, at(1));
    expect(admitted.ok).toBe(true);
    // A different high-risk step (different hash) is still gated.
    const other = admitControlStep(session.session_id, { ...step, ref: 'e4', step_id: 't-10' }, at(1));
    expect(other.ok === false && other.reason === 'approval_required').toBe(true);
  });

  it('hashControlStep is stable across equivalent payloads', () => {
    expect(hashControlStep({ op: 'delete', step_id: 's', ref: 'e1' })).toBe(
      hashControlStep({ op: 'delete', step_id: 's', ref: 'e1' })
    );
  });

  it('lists minted sessions', () => {
    mint();
    mint({ origin: 'https://example.com' });
    expect(listBrowserControlSessions().length).toBe(2);
  });
});

describe('control_step mailbox lifecycle', () => {
  it('accepts a schema-valid control_step request', () => {
    const session = mint();
    const request = enqueueStep(session);
    expect(request.request_kind).toBe('control_step');
    const loaded = loadBrowserBridgeRequest(request.request_id, { now: at(1) });
    expect(loaded?.status).toBe('pending');
  });

  it('rejects a non-canonical payload origin', () => {
    const session = mint();
    expect(() =>
      enqueueBrowserBridgeRequest(
        {
          request_kind: 'control_step',
          payload: {
            ...controlPayload(session),
            origin: 'https://api.slack.com:443',
          },
          requested_by: { actor_id: 'agent:test' },
          scope: { tier: 'personal' },
        },
        { now: T0, assertTenant: () => undefined }
      )
    ).toThrow(/canonical http\(s\) origin/);
  });

  it('stores a completed result, echoing the step and scrubbing secret_values', () => {
    const session = mint();
    const request = enqueueStep(session, { op: 'extract_text_ref', secret_name: 'xoxb' });
    const responded = respondBrowserBridgeRequest(
      request.request_id,
      {
        status: 'completed',
        origin: 'https://api.slack.com',
        result: {
          step: { step_id: 't-1', op: 'extract_text_ref' },
          outcome: { status: 'done' },
          secret_values: [{ name: 'xoxb', value: 'xoxb-123-secret' }],
        },
      },
      { now: at(2) }
    );
    const result = responded.response?.result ?? {};
    expect(result.secret_capture).toEqual(['xoxb']);
    expect(JSON.stringify(result)).not.toContain('xoxb-123-secret');
    expect(readBrowserControlSecrets(request.request_id)).toEqual({
      xoxb: 'xoxb-123-secret',
    });
    expect(readBrowserControlSecrets(request.request_id, { delete: true })).toEqual({
      xoxb: 'xoxb-123-secret',
    });
    expect(readBrowserControlSecrets(request.request_id)).toBeNull();
  });

  it('rejects a response whose step echo or origin mismatches', () => {
    const session = mint();
    const request = enqueueStep(session);
    expect(() =>
      respondBrowserBridgeRequest(
        request.request_id,
        {
          status: 'completed',
          origin: 'https://evil.example',
          result: { step: { step_id: 't-1', op: 'click_ref' } },
        },
        { now: at(2) }
      )
    ).toThrow(/does not match the session origin|canonical/);
    expect(() =>
      respondBrowserBridgeRequest(
        request.request_id,
        {
          status: 'completed',
          origin: 'https://api.slack.com',
          result: { step: { step_id: 'other', op: 'click_ref' } },
        },
        { now: at(2) }
      )
    ).toThrow(/echo the request step/);
  });

  it('rejects arbitrary ops at schema validation', () => {
    const session = mint();
    expect(() =>
      enqueueStep(session, { op: 'evaluate' as never, text: 'alert(1)' })
    ).toThrow();
  });
});
