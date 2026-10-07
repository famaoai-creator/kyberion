import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { saveGoldenScenario } from '../knowledge/golden-scenario-verdict.js';
import { resolveKnowledgeVerification } from '../knowledge/knowledge-verification.js';
import type { ProcedureEntry } from '../knowledge/procedure-types.js';
import { judgeExtensionRun, normalizeExtensionGoldenElements } from './browser-golden-evidence.js';

const root = pathResolver.sharedTmp(`extension-golden-${process.pid}`);
const feedbackDir = pathResolver.sharedTmp(`extension-golden-feedback-${process.pid}`);
const receiptStore = pathResolver.shared('runtime/browser-receipts');
const recordingRef = pathResolver.toRepoRelative(path.join(root, 'recording.json'));
let savedFeedbackDir: string | undefined;
let receiptIds: string[] = [];

beforeEach(() => {
  savedFeedbackDir = process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = feedbackDir;
  safeMkdir(root, { recursive: true });
  safeWriteFile(path.join(root, 'recording.json'), '{"recording":"v1"}\n');
  receiptIds = [];
});

afterEach(() => {
  if (savedFeedbackDir === undefined) delete process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  else process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = savedFeedbackDir;
  for (const id of receiptIds) {
    safeRmSync(path.join(receiptStore, `${id}.json`), { force: true });
    safeRmSync(path.join(receiptStore, `${id}.golden.json`), { force: true });
  }
  safeRmSync(root, { recursive: true, force: true });
  safeRmSync(feedbackDir, { recursive: true, force: true });
});

function procedure(withGolden = true): ProcedureEntry {
  const goldenRef = withGolden
    ? saveGoldenScenario(
        {
          schema_version: 'golden-scenario.v1',
          scenario_id: 'gs-ext',
          procedure_id: 'ext.approve',
          success_conditions: [{ kind: 'ref_visible', role: 'status', name_contains: 'approved' }],
          captured_from: 'rec-ext',
          version: '1.0.0',
        },
        path.join(root, 'golden.json')
      )
    : undefined;
  return {
    procedure_id: 'ext.approve',
    substrate: 'browser',
    adapter: {
      recorder: 'chrome-extension',
      executor: 'extension_session',
      recording_ref: recordingRef,
    },
    target: { name: 'Approvals', origins: ['https://example.com'] },
    intent_phrases: ['approve'],
    pipeline_ref: 'pipelines/browser/ext.json',
    risk_class: 'low',
    version: '1.0.0',
    status: 'active',
    ...(goldenRef ? { golden_scenario_ref: goldenRef } : {}),
  };
}

function receipt(status = 'completed', recordingId = 'rec-ext'): string {
  const id = `RCP-golden-test-${process.pid}-${receiptIds.length}`;
  receiptIds.push(id);
  safeMkdir(receiptStore, { recursive: true });
  safeWriteFile(
    path.join(receiptStore, `${id}.json`),
    JSON.stringify({
      kind: 'browser-extension-receipt.v1',
      receipt_id: id,
      mission_id: 'MSN-PROC-ext.approve',
      pipeline_id: 'pipelines/browser/ext.json',
      recording_id: recordingId,
      tab_id: '42',
      origin: 'https://example.com',
      status,
      lease_id: 'LEASE-1',
      created_at: '2026-10-07T00:00:00.000Z',
    })
  );
  return id;
}

const judge = (receiptId: string, elements: unknown, entry = procedure()) =>
  judgeExtensionRun({ procedure: entry, recordingId: 'rec-ext', receiptId, elements });

const ledger = () => resolveKnowledgeVerification([recordingRef]).get(recordingRef);

describe('judgeExtensionRun', () => {
  it('passes a completed run whose page shows the success state, and records golden evidence', () => {
    const result = judge(receipt(), [{ role: 'status', text: 'Request approved', visible: true }]);
    expect(result).toMatchObject({ ok: true, verdict: { verdict: 'pass' } });
    expect(ledger()).toMatchObject({ state: 'verified', evidence: 'golden' });
  });

  it('fails a completed run whose page shows something else, and records the failed check', () => {
    const result = judge(receipt(), [{ role: 'alert', text: 'Session expired', visible: true }]);
    expect(result).toMatchObject({ ok: true, verdict: { verdict: 'fail' } });
    expect(ledger()).toMatchObject({
      state: 'reported_problem',
      last_problem_kind: 'failed_check',
    });
  });

  it('judges each run once', () => {
    const id = receipt();
    expect(judge(id, [{ role: 'alert', text: 'Session expired' }])).toMatchObject({ ok: true });
    expect(judge(id, [{ role: 'status', text: 'Request approved' }])).toEqual({
      ok: false,
      error: 'this run has already been judged',
    });
  });

  it('refuses evidence that is not tied to a completed run of this procedure', () => {
    const elements = [{ role: 'status', text: 'Request approved' }];
    expect(judge('RCP-unknown', elements)).toMatchObject({ ok: false });
    expect(judge(receipt('failed'), elements)).toMatchObject({ ok: false });
    expect(judge(receipt('completed', 'rec-other'), elements)).toMatchObject({ ok: false });
    expect(judge(receipt(), 'not-a-list')).toMatchObject({ ok: false });
    expect(ledger()?.state).toBeUndefined();
  });

  it('records nothing for a procedure without a golden scenario', () => {
    const id = receipt();
    expect(judge(id, [], procedure(false))).toEqual({ ok: true, verdict: null });
    expect(safeExistsSync(path.join(receiptStore, `${id}.golden.json`))).toBe(false);
  });
});

describe('normalizeExtensionGoldenElements', () => {
  it('bounds what the extension can send', () => {
    const many = Array.from({ length: 500 }, () => ({ role: 'x', text: 'y'.repeat(1000) }));
    const normalized = normalizeExtensionGoldenElements([null, 7, ...many])!;
    expect(normalized).toHaveLength(200);
    expect(normalized[0].text).toHaveLength(300);
    expect(normalizeExtensionGoldenElements({})).toBeUndefined();
  });
});
