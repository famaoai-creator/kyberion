import { afterEach, describe, expect, it, vi } from 'vitest';
import * as secureIo from './secure-io.js';
import {
  applyProcedureDelta,
  classifyFailure,
  createProcedureDelta,
  loadProcedureDelta,
  saveProcedureDelta,
  suggestRepairAnchor,
} from './procedure-self-repair.js';
import type { CompiledBrowserStep } from './browser-recording-compiler.js';
import type { BrowserExtensionRecording } from './browser-extension-bridge.js';
import type { ProcedureDelta } from './procedure-types.js';

function rec(actions: Array<{ action_id: string; op: string }>): BrowserExtensionRecording {
  return {
    schema_version: 'browser-recording.v1',
    recording_id: 'REC-base',
    source: 'chrome-extension',
    created_at: '2026-06-24T00:00:00.000Z',
    tab: { origin: 'https://x.example', origin_hash: 'h', title: 't' },
    extension: { version: '1.0.0' },
    actions: actions.map((a) => ({ ...a, summary: a.op, risk: 'low', captured_at: '2026-06-24T00:00:00.000Z' })) as any,
    risk_summary: { requires_manual_review: true, sensitive_input_omitted: 0, approval_required_count: 0 },
    review: { status: 'approved', decisions: [] },
  };
}

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it.each([
    ['MFA authentication required', undefined, 'mfa'],
    ['OTP 入力が必要です', undefined, 'mfa'],
    ['二段階認証', undefined, 'mfa'],
    ['unexpected modal appeared', undefined, 'new_popup'],
    ['ダイアログが出ました', undefined, 'new_popup'],
    ['origin changed during navigation', undefined, 'handoff'],
    ['ページ遷移が発生しました', undefined, 'handoff'],
    ['element not found', undefined, 'ambiguity'],
    ['ref lookup failed', undefined, 'ambiguity'],
    ['なにかが壊れた', undefined, 'ambiguity'],
  ] as Array<[string, undefined, ProcedureDelta['reason']]>)(
    '"%s" → %s',
    (errorMsg, _step, expected) => {
      expect(classifyFailure(new Error(errorMsg))).toBe(expected);
    },
  );

  it('uses step summary for classification when error is generic', () => {
    const step: Pick<CompiledBrowserStep, 'op' | 'summary'> = {
      op: 'fill_ref',
      summary: 'MFA コード入力',
    };
    expect(classifyFailure(new Error('fill failed'), step)).toBe('mfa');
  });

  it('handles non-Error thrown values', () => {
    expect(classifyFailure('unexpected modal overlay appeared')).toBe('new_popup');
    expect(classifyFailure(42)).toBe('ambiguity');
  });
});

// ---------------------------------------------------------------------------
// createProcedureDelta
// ---------------------------------------------------------------------------

describe('createProcedureDelta', () => {
  const fixedNow = new Date('2026-06-24T10:00:00Z');

  it('creates a valid ProcedureDelta', () => {
    const delta = createProcedureDelta({
      procedureId: 'attendance.approve.kingoftime',
      anchorStepIndex: 3,
      deltaRecordingRef: 'active/shared/runtime/recordings/REC-001.json',
      reason: 'mfa',
      now: fixedNow,
    });
    expect(delta.schema_version).toBe('procedure-delta.v1');
    expect(delta.procedure_id).toBe('attendance.approve.kingoftime');
    expect(delta.anchor.step_index).toBe(3);
    expect(delta.anchor.ref_snapshot_hash).toBeUndefined();
    expect(delta.delta_recording_ref).toBe('active/shared/runtime/recordings/REC-001.json');
    expect(delta.reason).toBe('mfa');
    expect(delta.created_at).toBe('2026-06-24T10:00:00.000Z');
  });

  it('includes ref_snapshot_hash when provided', () => {
    const hash = 'a'.repeat(64);
    const delta = createProcedureDelta({
      procedureId: 'p1',
      anchorStepIndex: 0,
      anchorSnapshotHash: hash,
      deltaRecordingRef: 'r',
      reason: 'ambiguity',
      now: fixedNow,
    });
    expect(delta.anchor.ref_snapshot_hash).toBe(hash);
  });

  it('uses current time when now is not provided', () => {
    const before = Date.now();
    const delta = createProcedureDelta({
      procedureId: 'p1',
      anchorStepIndex: 0,
      deltaRecordingRef: 'r',
      reason: 'ambiguity',
    });
    const after = Date.now();
    const ts = Date.parse(delta.created_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// saveProcedureDelta / loadProcedureDelta
// ---------------------------------------------------------------------------

describe('saveProcedureDelta / loadProcedureDelta', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes JSON to the correct path and returns the path', () => {
    const mkdirSpy = vi.spyOn(secureIo, 'safeMkdir').mockReturnValue(undefined as any);
    const writeSpy = vi.spyOn(secureIo, 'safeWriteFile').mockReturnValue(undefined);

    const delta: ProcedureDelta = {
      schema_version: 'procedure-delta.v1',
      procedure_id: 'test.proc',
      anchor: { step_index: 2 },
      delta_recording_ref: 'r',
      reason: 'new_popup',
      created_at: '2026-06-24T10:00:00.000Z',
    };

    const path = saveProcedureDelta(delta);

    expect(mkdirSpy).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = writeSpy.mock.calls[0];
    expect(writtenPath).toContain('test.proc');
    expect(writtenPath).toContain('delta-');
    expect(path).toBe(writtenPath);
    const parsed = JSON.parse(writtenContent as string);
    expect(parsed.procedure_id).toBe('test.proc');
    expect(parsed.reason).toBe('new_popup');
  });

  it('loads a delta from a file path', () => {
    const delta: ProcedureDelta = {
      schema_version: 'procedure-delta.v1',
      procedure_id: 'p1',
      anchor: { step_index: 0 },
      delta_recording_ref: 'r',
      reason: 'ambiguity',
      created_at: '2026-06-24T00:00:00Z',
    };
    vi.spyOn(secureIo, 'safeReadFile').mockReturnValue(JSON.stringify(delta));
    const loaded = loadProcedureDelta('/some/path.json');
    expect(loaded).toEqual(delta);
  });

  it('returns null when file is missing', () => {
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(loadProcedureDelta('/missing.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyProcedureDelta
// ---------------------------------------------------------------------------

describe('applyProcedureDelta', () => {
  const base = rec([
    { action_id: 'a0', op: 'click_ref' },
    { action_id: 'a1', op: 'fill_ref' },
    { action_id: 'a2', op: 'submit_form' },
  ]);
  const delta = rec([{ action_id: 'd0', op: 'click_ref' }]);
  delta.recording_id = 'REC-delta';

  it('splices corrective steps after the anchor and forces re-review', () => {
    const d: ProcedureDelta = {
      schema_version: 'procedure-delta.v1',
      procedure_id: 'p1',
      anchor: { step_index: 1 }, // after the fill_ref (a1)
      delta_recording_ref: 'r',
      reason: 'ambiguity',
      created_at: '2026-06-24T10:00:00.000Z',
    };
    const merged = applyProcedureDelta({ baseRecording: base, deltaRecording: delta, delta: d });
    expect(merged.actions.map((a) => a.action_id)).toEqual(['a0', 'a1', 'd0', 'a2']);
    expect(merged.review?.status).toBe('pending');
    expect(merged.recording_id).toContain('+delta-');
    // submit_form is high-risk → risk_summary recomputed
    expect(merged.risk_summary.approval_required_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// suggestRepairAnchor
// ---------------------------------------------------------------------------

describe('suggestRepairAnchor', () => {
  const step: CompiledBrowserStep = {
    step_index: 5,
    op: 'click_ref',
    summary: '承認ボタンをクリック',
    risk: 'low',
    snapshot_hash: 'abc123',
  };

  it('returns stepIndex and snapshotHash from the failed step', () => {
    const anchor = suggestRepairAnchor(step, new Error('element not found'));
    expect(anchor.stepIndex).toBe(5);
    expect(anchor.snapshotHash).toBe('abc123');
  });

  it('classifies the failure reason', () => {
    expect(suggestRepairAnchor(step, new Error('MFA required')).reason).toBe('mfa');
    expect(suggestRepairAnchor(step, new Error('dialog appeared')).reason).toBe('new_popup');
    expect(suggestRepairAnchor(step, new Error('generic')).reason).toBe('ambiguity');
  });

  it('works without snapshot_hash on the step', () => {
    const stepNoHash: CompiledBrowserStep = { ...step, snapshot_hash: undefined };
    const anchor = suggestRepairAnchor(stepNoHash, new Error('err'));
    expect(anchor.snapshotHash).toBeUndefined();
  });
});
