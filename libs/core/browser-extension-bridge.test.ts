import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AjvModule from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBrowserExtensionPipelineCandidate,
  buildBrowserExtensionReceipt,
  compileBrowserRecordingToPipeline,
  hashBrowserExtensionAction,
  issueBrowserExtensionLease,
  issueSegmentedLeases,
  persistBrowserExtensionReceipt,
  preflightBrowserExtensionSession,
  segmentRecording,
  subRecordingForSegment,
  validateBrowserExtensionRecording,
  validateBrowserExtensionReceipt,
} from './browser-extension-bridge.js';
import { pathResolver } from './path-resolver.js';
import * as secureIo from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function recording(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'browser-recording.v1',
    recording_id: 'REC-1',
    source: 'chrome-extension',
    created_at: '2026-06-23T00:00:00.000Z',
    tab: {
      origin: 'https://example.com',
      origin_hash: sha256('https://example.com'),
      title: 'Example',
    },
    extension: { version: '0.1.0' },
    actions: [
      {
        action_id: 'step-1',
        op: 'click_ref',
        summary: 'Continue を選択',
        risk: 'low',
        captured_at: '2026-06-23T00:00:01.000Z',
        target: {
          ref: '@e1',
          role: 'button',
          name: 'Continue',
          snapshot_hash: sha256('snapshot-1'),
        },
      },
      {
        action_id: 'step-2',
        op: 'fill_ref',
        summary: '会社名を入力（値は保存しない）',
        risk: 'low',
        captured_at: '2026-06-23T00:00:02.000Z',
        target: {
          ref: '@e2',
          role: 'textbox',
          name: 'Company name',
          snapshot_hash: sha256('snapshot-1'),
        },
        variable: { name: 'company_name', classification: 'user_input' },
      },
    ],
    risk_summary: {
      requires_manual_review: true,
      sensitive_input_omitted: 0,
      approval_required_count: 0,
    },
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'browser-extension-session.v1',
    mission_id: 'MSN-1',
    pipeline_id: 'browser-candidate-1',
    tab_id: '42',
    origin: 'https://example.com',
    mode: 'record',
    recording_id: 'REC-1',
    requested_operations: ['click_ref', 'fill_ref'],
    ...overrides,
  };
}

describe('browser extension bridge contracts', () => {
  it('accepts redacted recordings and emits a review-only pipeline candidate', () => {
    const parsed = validateBrowserExtensionRecording(recording());
    expect(parsed.valid).toBe(true);
    expect(buildBrowserExtensionPipelineCandidate(parsed.value!).requires_manual_review).toBe(true);
  });

  it('rejects recorded input values and raw selectors', () => {
    const withValue = recording({
      actions: [{
        ...recording().actions[1],
        value: 'secret@example.com',
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });
    const withSelector = recording({
      actions: [{
        ...recording().actions[0],
        selector: '#continue',
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });

    expect(validateBrowserExtensionRecording(withValue).valid).toBe(false);
    expect(validateBrowserExtensionRecording(withSelector).valid).toBe(false);
  });

  it('requires a variable for every fill action', () => {
    const invalid = recording({
      actions: [{
        ...recording().actions[1],
        variable: undefined,
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });
    expect(validateBrowserExtensionRecording(invalid).errors).toContain('action step-2 must use a variable instead of a recorded value');
  });

  it('requires review and binds session origin to the recording origin', () => {
    const result = preflightBrowserExtensionSession({
      recording: recording(),
      session: session({ origin: 'https://other.example' }),
    });
    expect(result.status).toBe('blocked');
    expect(result.errors).toContain('session origin must match recording origin');
  });

  it('requires explicit approval hashes for high-risk actions', () => {
    const highRiskAction = {
      ...recording().actions[0],
      action_id: 'purchase-1',
      op: 'purchase',
      summary: '購入を確定する',
      risk: 'high',
    };
    const highRiskRecording = recording({
      actions: [highRiskAction],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 1,
      },
    });
    const actionHash = hashBrowserExtensionAction(highRiskAction as any);
    const review = preflightBrowserExtensionSession({
      recording: highRiskRecording,
      session: session({ requested_operations: ['purchase'] }),
    });
    const execute = preflightBrowserExtensionSession({
      recording: highRiskRecording,
      session: session({
        mode: 'execute',
        requested_operations: ['purchase'],
        lease: {
          lease_id: 'lease-1',
          issued_at: '2026-06-23T00:00:00.000Z',
          expires_at: '2026-06-24T00:00:00.000Z',
          approved_step_hashes: [actionHash],
        },
      }),
      now: new Date('2026-06-23T12:00:00.000Z'),
    });

    expect(review.status).toBe('approval_required');
    expect(execute.status).toBe('blocked');
    expect(execute.errors).toContain('extension execution is unavailable until the Native Messaging bridge is installed');
  });

  it('validates redacted execution receipts', () => {
    expect(validateBrowserExtensionReceipt({
      kind: 'browser-extension-receipt.v1',
      receipt_id: 'RCP-1',
      mission_id: 'MSN-1',
      pipeline_id: 'browser-candidate-1',
      recording_id: 'REC-1',
      tab_id: '42',
      origin: 'https://example.com',
      status: 'blocked',
      created_at: '2026-06-23T00:00:00.000Z',
    }).valid).toBe(true);
  });

  it('emits only approved actions after review is finalized', () => {
    const reviewed = recording({
      review: {
        status: 'approved',
        reviewed_at: '2026-06-23T00:01:00.000Z',
        decisions: [
          { action_id: 'step-1', status: 'approved' },
          { action_id: 'step-2', status: 'rejected', reason: '入力は手動で行う' },
        ],
      },
    });
    const candidate = buildBrowserExtensionPipelineCandidate(reviewed as any);

    expect(candidate.review_status).toBe('approved');
    expect(candidate.operations).toEqual(['click_ref']);
    expect(candidate.excluded_action_ids).toEqual(['step-2']);
  });

  it('rejects recordings whose human-readable text still carries raw PII', () => {
    const leakedName = recording({
      actions: [{
        ...recording().actions[0],
        target: { ...recording().actions[0].target, name: 'contact alice@example.com' },
      }],
    });
    const leakedSummary = recording({
      actions: [{
        ...recording().actions[0],
        summary: 'カード番号 4111111111111111 を確認',
      }],
    });

    expect(validateBrowserExtensionRecording(leakedName).errors).toContain('action step-1 contains unredacted PII-like text');
    expect(validateBrowserExtensionRecording(leakedSummary).errors).toContain('action step-1 contains unredacted PII-like text');
  });

  it('rejects a target name that carries captured body text instead of a label', () => {
    const bodyText = recording({
      actions: [{
        ...recording().actions[0],
        op: 'submit_form',
        risk: 'high',
        target: { ...recording().actions[0].target, role: 'form', name: 'あ'.repeat(400) },
      }],
      risk_summary: { requires_manual_review: true, sensitive_input_omitted: 0, approval_required_count: 1 },
    });
    expect(validateBrowserExtensionRecording(bodyText).errors)
      .toContain('action step-1 target name looks like captured body text, not a label');
  });

  it('accepts a navigate handoff action with a valid origin pair', () => {
    const withHandoff = recording({
      actions: [
        recording().actions[0],
        {
          action_id: 'nav-1',
          op: 'navigate',
          summary: 'example.com → news.example.com に移動',
          risk: 'observe',
          captured_at: '2026-06-23T00:00:03.000Z',
          navigation: { from_origin: 'https://example.com', to_origin: 'https://news.example.com' },
        },
      ],
    });
    expect(validateBrowserExtensionRecording(withHandoff).valid).toBe(true);
  });

  it('rejects a navigate action without a navigation origin pair', () => {
    const bad = recording({
      actions: [{
        action_id: 'nav-1', op: 'navigate', summary: '移動', risk: 'observe',
        captured_at: '2026-06-23T00:00:03.000Z',
      }],
    });
    expect(validateBrowserExtensionRecording(bad).valid).toBe(false);
  });

  it('rejects navigation attached to a non-navigate op', () => {
    const bad = recording({
      actions: [{
        ...recording().actions[0],
        navigation: { from_origin: 'https://example.com', to_origin: 'https://news.example.com' },
      }],
    });
    expect(validateBrowserExtensionRecording(bad).valid).toBe(false);
  });

  it('requires an explicit option or toggle state for selection actions', () => {
    const selection = {
      ...recording().actions[0],
      action_id: 'step-select',
      op: 'select_ref',
      summary: '通知を有効にする',
    };
    const missingState = recording({ actions: [selection] });
    const withState = recording({
      actions: [{ ...selection, selection: { kind: 'toggle', checked: true } }],
    });

    expect(validateBrowserExtensionRecording(missingState).valid).toBe(false);
    expect(validateBrowserExtensionRecording(withState).valid).toBe(true);
  });

  function approvedHighRiskRecording() {
    const submit = {
      ...recording().actions[0],
      action_id: 'submit-1',
      op: 'submit_form',
      summary: 'フォームを送信',
      risk: 'high',
    };
    return recording({
      actions: [submit],
      risk_summary: { requires_manual_review: true, sensitive_input_omitted: 0, approval_required_count: 1 },
      review: {
        status: 'approved',
        reviewed_at: '2026-06-23T00:01:00.000Z',
        decisions: [{ action_id: 'submit-1', status: 'approved' }],
      },
    });
  }

  it('blocks lease issuance for high-risk actions without granted approval', () => {
    const reviewed = validateBrowserExtensionRecording(approvedHighRiskRecording());
    const result = issueBrowserExtensionLease({
      recording: reviewed.value!,
      session: session({ mode: 'execute', requested_operations: ['submit_form'] }) as any,
      approval: { allowed: false, status: 'pending' },
    });
    expect(result.lease).toBeUndefined();
    expect(result.errors).toContain('lease requires granted approval for high-risk actions');
  });

  it('issues a lease bound to approved high-risk step hashes', () => {
    const reviewed = validateBrowserExtensionRecording(approvedHighRiskRecording());
    const issued = issueBrowserExtensionLease({
      recording: reviewed.value!,
      session: session({ mode: 'execute', requested_operations: ['submit_form'] }) as any,
      approval: { allowed: true, status: 'approved' },
      now: new Date('2026-06-23T00:00:00.000Z'),
      ttlMs: 60_000,
    });
    expect(issued.errors).toEqual([]);
    expect(issued.lease?.expires_at).toBe('2026-06-23T00:01:00.000Z');
    expect(issued.lease?.approved_step_hashes).toHaveLength(1);
  });

  it('blocks execute-mode preflight when the lease has expired', () => {
    const issued = issueBrowserExtensionLease({
      recording: validateBrowserExtensionRecording(approvedHighRiskRecording()).value!,
      session: session({ mode: 'execute', requested_operations: ['submit_form'] }) as any,
      approval: { allowed: true, status: 'approved' },
      now: new Date('2026-06-23T00:00:00.000Z'),
      ttlMs: 60_000,
    });
    const result = preflightBrowserExtensionSession({
      recording: approvedHighRiskRecording(),
      session: session({ mode: 'execute', requested_operations: ['submit_form'], lease: issued.lease }),
      bridgeAvailable: true,
      now: new Date('2026-06-23T01:00:00.000Z'), // well past expiry
    });
    expect(result.status).toBe('blocked');
    expect(result.errors).toContain('execution lease is expired');
  });

  it('accepts execute-mode preflight once the bridge is available with a valid lease', () => {
    const reviewed = validateBrowserExtensionRecording(approvedHighRiskRecording());
    const issued = issueBrowserExtensionLease({
      recording: reviewed.value!,
      session: session({ mode: 'execute', requested_operations: ['submit_form'] }) as any,
      approval: { allowed: true, status: 'approved' },
      now: new Date('2026-06-23T00:00:00.000Z'),
    });
    const result = preflightBrowserExtensionSession({
      recording: approvedHighRiskRecording(),
      session: session({ mode: 'execute', requested_operations: ['submit_form'], lease: issued.lease }),
      bridgeAvailable: true,
      now: new Date('2026-06-23T00:00:30.000Z'),
    });
    expect(result.status).toBe('approval_required');
    expect(result.errors).toEqual([]);
  });

  it('crystallizes an approved recording into a schema-conformant draft pipeline', () => {
    const reviewed = recording({
      review: {
        status: 'approved',
        reviewed_at: '2026-06-23T00:01:00.000Z',
        decisions: [
          { action_id: 'step-1', status: 'approved' },
          { action_id: 'step-2', status: 'approved' },
        ],
      },
    });
    const draft = compileBrowserRecordingToPipeline(reviewed as any);

    const schema = JSON.parse(
      readFileSync(pathResolver.rootResolve('knowledge/product/schemas/browser-pipeline.schema.json'), 'utf8'),
    );
    const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

    expect(validate(draft)).toBe(true);
    expect(draft._draft).toBe(true);
    expect(draft.steps.map((step: any) => step.op)).toEqual(['click', 'fill']);
    // fill step parameterizes the value rather than embedding it
    expect(draft.steps[1].params.text).toBe('{{company_name}}');
    expect(draft._review_required).toContain('Resolve ref → Playwright selector for every step before promotion');
  });

  it('flags high-risk and unfinalized recordings as needing review before promotion', () => {
    const draft = compileBrowserRecordingToPipeline(approvedHighRiskRecording() as any);
    expect(draft._review_required).toContain('High-risk steps require an approval gate at run time');
    expect(draft.steps[0].params.high_risk).toBe(true);
  });

  it('builds a schema-valid receipt from a session', () => {
    const receipt = buildBrowserExtensionReceipt({
      session: session({ mode: 'execute' }) as any,
      status: 'completed',
      leaseId: 'LEASE-1',
      summary: '1 操作を実行しました',
      now: new Date('2026-06-23T00:05:00.000Z'),
    });
    expect(validateBrowserExtensionReceipt(receipt).valid).toBe(true);
    expect(receipt.status).toBe('completed');
  });

  describe('persistBrowserExtensionReceipt (OP-H3)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('persists a valid receipt through secure-io and returns the path', () => {
      const mkdir = vi.spyOn(secureIo, 'safeMkdir').mockReturnValue(undefined as any);
      const write = vi.spyOn(secureIo, 'safeWriteFile').mockReturnValue(undefined);
      const receipt = buildBrowserExtensionReceipt({
        session: session({ mode: 'execute' }) as any,
        status: 'completed',
        leaseId: 'LEASE-1',
        now: new Date('2026-06-23T00:05:00.000Z'),
      });
      const result = persistBrowserExtensionReceipt(receipt);
      expect(result.errors).toHaveLength(0);
      expect(result.path).toContain(receipt.receipt_id);
      expect(mkdir).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
    });

    it('refuses to write an invalid receipt', () => {
      const write = vi.spyOn(secureIo, 'safeWriteFile').mockReturnValue(undefined);
      const result = persistBrowserExtensionReceipt({ kind: 'wrong' });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.path).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    });
  });
});

describe('segmented (multi-origin) execution', () => {
  function navAction(from: string, to: string) {
    return {
      action_id: `nav-${to}`, op: 'navigate' as const, summary: 'handoff', risk: 'observe' as const,
      captured_at: '2026-06-23T00:00:03.000Z', navigation: { from_origin: from, to_origin: to },
    };
  }
  function clickAction(id: string) {
    return {
      action_id: id, op: 'click_ref' as const, summary: 'click', risk: 'low' as const,
      captured_at: '2026-06-23T00:00:01.000Z',
      target: { ref: `@${id}`, role: 'button', name: 'Go', snapshot_hash: sha256(id) },
    };
  }

  it('splits a recording into per-origin segments at navigate boundaries', () => {
    const rec = recording({
      actions: [
        clickAction('a1'),
        navAction('https://example.com', 'https://news.example.com'),
        clickAction('a2'),
      ],
    });
    const segments = segmentRecording(rec as any);
    expect(segments).toHaveLength(2);
    expect(segments[0].origin).toBe('https://example.com');
    expect(segments[0].actions.map((a) => a.action_id)).toEqual(['a1']);
    expect(segments[1].origin).toBe('https://news.example.com');
    expect(segments[1].entryFrom).toBe('https://example.com');
    expect(segments[1].actions.map((a) => a.action_id)).toEqual(['a2']);
    // navigate markers are boundaries, never included in a segment's actions
    expect(segments.flatMap((s) => s.actions).some((a) => a.op === 'navigate')).toBe(false);
  });

  it('builds a single-origin sub-recording with a recomputed origin_hash', () => {
    const rec = recording({ actions: [clickAction('a1'), navAction('https://example.com', 'https://news.example.com'), clickAction('a2')] });
    const seg = segmentRecording(rec as any)[1];
    const sub = subRecordingForSegment(rec as any, seg);
    expect(sub.tab.origin).toBe('https://news.example.com');
    expect(sub.tab.origin_hash).toBe(sha256('https://news.example.com'));
    expect(sub.actions.map((a) => a.action_id)).toEqual(['a2']);
  });

  it('issues one origin-bound lease per segment', () => {
    const rec = recording({
      actions: [clickAction('a1'), navAction('https://example.com', 'https://news.example.com'), clickAction('a2')],
      review: { status: 'approved', reviewed_at: '2026-06-23T00:01:00.000Z', decisions: [
        { action_id: 'a1', status: 'approved' }, { action_id: 'a2', status: 'approved' },
      ] },
    });
    const result = issueSegmentedLeases({
      recording: rec as any,
      session: session({ mode: 'execute', requested_operations: ['click_ref'] }) as any,
      approval: { allowed: true, status: 'not_required' },
    });
    expect(result.errors).toHaveLength(0);
    expect(result.leases).toHaveLength(2);
    expect(result.leases?.[0]).toMatchObject({ segment_index: 0, origin: 'https://example.com' });
    expect(result.leases?.[1]).toMatchObject({ segment_index: 1, origin: 'https://news.example.com' });
    expect(result.leases?.[1].lease.origin).toBe('https://news.example.com');
    expect(result.leases?.[1].lease.segment_index).toBe(1);
  });
});
