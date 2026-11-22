import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import {
  BROWSER_BRIDGE_MAILBOX_ROOT,
  BROWSER_CONTROL_SECRET_ROOT,
  browserBridgeMailboxSignature,
  enqueueBrowserBridgeRequest,
  loadBrowserBridgeRequest,
  readBrowserControlSecrets,
  respondBrowserBridgeRequest,
  type BrowserBridgeControlStepPayload,
} from './browser-bridge-mailbox.js';
import {
  BROWSER_CONTROL_SESSION_ROOT,
  admitControlStep,
  appendBrowserControlJournal,
  hashControlStep,
  listBrowserControlSessions,
  loadBrowserControlSession,
  mintBrowserControlSession,
  recordApprovedControlStep,
  revokeBrowserControlSession,
} from './browser-control-sessions.js';
import {
  exportBrowserControlRecording,
  listExportedRecordings,
  loadExportedRecording,
  reviewExportedRecording,
} from './browser-control-recording.js';
import { enqueueSessionStep } from './browser-control-service.js';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser/browser-extension-bridge';

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
    const other = admitControlStep(
      session.session_id,
      { ...step, ref: 'e4', step_id: 't-10' },
      at(1)
    );
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

  it('mailbox signature changes on enqueue and respond', () => {
    const before = browserBridgeMailboxSignature();
    const session = mint();
    const request = enqueueStep(session);
    const afterEnqueue = browserBridgeMailboxSignature();
    expect(afterEnqueue).not.toBe(before);
    respondBrowserBridgeRequest(
      request.request_id,
      {
        status: 'completed',
        origin: 'https://api.slack.com',
        result: { step: { step_id: 't-1', op: 'click_ref' } },
      },
      { now: at(2) }
    );
    expect(browserBridgeMailboxSignature()).not.toBe(afterEnqueue);
  });

  it('rejects arbitrary ops at schema validation', () => {
    const session = mint();
    expect(() => enqueueStep(session, { op: 'evaluate' as never, text: 'alert(1)' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Journal → browser-recording export (interactive → promote path)
// ---------------------------------------------------------------------------

const RECORDINGS_DIR = pathResolver.rootResolve('active/shared/runtime/recordings');
const exportedIds: string[] = [];

function journalEnqueuedStep(
  sessionId: string,
  step: Record<string, unknown>,
  outcome: 'completed' | 'failed' | 'none' = 'completed'
): void {
  const requestId = `req-${String(step.step_id)}`;
  appendBrowserControlJournal(sessionId, {
    event: 'step.enqueued',
    step_id: step.step_id,
    op: step.op,
    request_id: requestId,
    ...(step.ref ? { ref: step.ref } : {}),
    step,
  });
  if (outcome !== 'none') {
    appendBrowserControlJournal(sessionId, {
      event: `step.${outcome}`,
      step_id: step.step_id,
      request_id: requestId,
    });
  }
}

afterEach(() => {
  for (const id of exportedIds.splice(0)) {
    const file = `${RECORDINGS_DIR}/${id}.json`;
    if (safeExistsSync(file)) safeRmSync(file);
  }
});

describe('browser control journal → recording export', () => {
  it('compiles enqueued steps into a schema-valid browser-recording', () => {
    const session = mint();
    journalEnqueuedStep(session.session_id, {
      step_id: 's-1',
      op: 'navigate',
      url: 'https://api.slack.com/apps/manage',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-2',
      op: 'snapshot',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-3',
      op: 'click_ref',
      ref: '@button_a1b2_1',
      role: 'button',
      name: 'Create app',
      label: 'open create dialog',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-4',
      op: 'fill_ref',
      ref: '@textbox_c3d4_1',
      role: 'textbox',
      name: 'App name',
      value: 'my-bot',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-5',
      op: 'delete',
      ref: '@button_e5f6_1',
      role: 'button',
      name: 'Delete app',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-6',
      op: 'open_tab',
      url: 'https://api.slack.com/apps/manage',
    });

    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    exportedIds.push(out.recording_id);

    // snapshot is observation-only; open_tab is session establishment — the
    // action schema has no url field and replay opens tab.origin itself.
    expect(out.action_count).toBe(4);
    expect(out.skipped_steps).toBe(2);

    const file = pathResolver.rootResolve(out.recording_ref);
    const recording = loadBrowserExtensionRecordingAtPath(file);
    expect(recording.schema_version).toBe('browser-recording.v1');
    expect(recording.tab.origin).toBe('https://api.slack.com');
    expect(recording.review?.status).toBe('pending');
    expect(recording.review?.decisions).toHaveLength(4);

    const [nav, click, fill, del] = recording.actions;
    expect(nav.op).toBe('navigate');
    expect(nav.risk).toBe('observe');
    expect(nav.navigation).toEqual({
      from_origin: 'https://api.slack.com',
      to_origin: 'https://api.slack.com',
    });
    expect(click.target?.ref).toBe('@button_a1b2_1');
    expect(click.risk).toBe('low');
    expect(fill.variable).toEqual({ name: 'app_name', classification: 'user_input' });
    expect(del.op).toBe('delete');
    expect(del.risk).toBe('high');
    expect(recording.risk_summary.approval_required_count).toBe(1);
  });

  it('fails cleanly when the session has no replayable steps', () => {
    const session = mint();
    journalEnqueuedStep(session.session_id, { step_id: 's-1', op: 'snapshot' });
    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.reason).toMatch(/no replayable actions/);
  });

  it('rejects export for unknown sessions', () => {
    const out = exportBrowserControlRecording({
      session_id: 'BCS-00000000-0000-0000-0000-000000000000',
    });
    expect(out.status).toBe('error');
  });

  it('review decisions merge and gate promotion status', () => {
    const session = mint();
    journalEnqueuedStep(session.session_id, {
      step_id: 's-1',
      op: 'click_ref',
      ref: '@button_a1b2_1',
      role: 'button',
      name: 'OK',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-2',
      op: 'click_ref',
      ref: '@button_c3d4_2',
      role: 'button',
      name: 'Cancel',
    });
    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    exportedIds.push(out.recording_id);

    const partial = reviewExportedRecording({
      recording_id: out.recording_id,
      approve: ['act-001'],
    });
    expect(partial).toEqual({ status: 'reviewed', review_status: 'in_review' });

    const second = reviewExportedRecording({
      recording_id: out.recording_id,
      approve: ['act-002'],
    });
    expect(second).toEqual({ status: 'reviewed', review_status: 'approved' });

    const stored = loadExportedRecording(out.recording_id);
    expect(stored?.review?.status).toBe('approved');
    expect(stored?.review?.decisions.every((d) => d.status === 'approved')).toBe(true);

    const listed = listExportedRecordings();
    expect(listed.some((entry) => entry.recording_id === out.recording_id)).toBe(true);
  });

  it('exports only steps that reported a completed outcome', () => {
    const session = mint();
    journalEnqueuedStep(session.session_id, {
      step_id: 's-ok',
      op: 'click_ref',
      ref: '@button_a1_1',
      role: 'button',
      name: 'Save',
    });
    journalEnqueuedStep(
      session.session_id,
      { step_id: 's-fail', op: 'click_ref', ref: '@button_b2_2', role: 'button' },
      'failed'
    );
    journalEnqueuedStep(
      session.session_id,
      { step_id: 's-pending', op: 'navigate', url: 'https://api.slack.com/x' },
      'none'
    );

    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    exportedIds.push(out.recording_id);
    expect(out.action_count).toBe(1);
    expect(out.dropped_unexecuted).toBe(2);
  });

  it('errors with an unexecuted count when nothing completed', () => {
    const session = mint();
    journalEnqueuedStep(
      session.session_id,
      { step_id: 's-1', op: 'click_ref', ref: '@b1' },
      'failed'
    );
    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.reason).toMatch(/no completed steps.*1 enqueued/);
  });

  it('skips a press_ref whose non-default key the replay cannot express', () => {
    const session = mint();
    journalEnqueuedStep(session.session_id, {
      step_id: 's-1',
      op: 'press_ref',
      ref: '@input_1',
      key: 'Tab',
    });
    journalEnqueuedStep(session.session_id, {
      step_id: 's-2',
      op: 'click_ref',
      ref: '@button_2',
      role: 'button',
      name: 'Go',
    });
    const out = exportBrowserControlRecording({ session_id: session.session_id });
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    exportedIds.push(out.recording_id);
    expect(out.action_count).toBe(1);
    expect(out.skipped_steps).toBe(1);
  });

  it('tolerates malformed ids and stray files in the recordings store', () => {
    expect(loadExportedRecording('.hidden')).toBeNull();
    expect(loadExportedRecording('nope/../x')).toBeNull();
  });

  it('scrubs fill_ref values from the journal at write time', () => {
    // enqueueSessionStep admits against the real clock — anchor at now.
    const session = mint({ now: new Date() });
    const enqueued = enqueueSessionStep({
      session_id: session.session_id,
      step: {
        step_id: 's-fill',
        op: 'fill_ref',
        ref: '@textbox_1',
        value: 'hunter2-super-secret',
      },
      actor: { actor_id: 'agent:test', mission_id: 'MSN-TEST-1' },
    });
    expect(enqueued.status).toBe('queued');

    const journal = pathResolver.rootResolve(
      `${BROWSER_CONTROL_SESSION_ROOT}/${session.session_id}.journal.jsonl`
    );
    const raw = String(safeReadFile(journal, { encoding: 'utf8' }));
    expect(raw).not.toContain('hunter2-super-secret');
    const entry = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'step.enqueued');
    expect((entry?.step as Record<string, unknown>).value_redacted).toBe(true);
  });
});
