import { describe, expect, it } from 'vitest';
import {
  compileBrowserRecording,
  isDryRunSafe,
} from './browser-recording-compiler.js';
import type { BrowserExtensionRecording } from './browser-extension-bridge.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_RECORDING: BrowserExtensionRecording = {
  schema_version: 'browser-recording.v1',
  recording_id: 'rec-001',
  source: 'chrome-extension',
  created_at: '2026-06-24T00:00:00Z',
  tab: {
    origin: 'https://s2.kingtime.jp',
    origin_hash: 'abc123',
    title: 'King of Time',
  },
  extension: { version: '1.0.0' },
  actions: [],
  risk_summary: {
    requires_manual_review: true,
    sensitive_input_omitted: 0,
    approval_required_count: 0,
  },
};

function makeAction(
  op: BrowserExtensionRecording['actions'][number]['op'],
  overrides: Partial<BrowserExtensionRecording['actions'][number]> = {},
): BrowserExtensionRecording['actions'][number] {
  return {
    action_id: `act-${Math.random().toString(36).slice(2, 8)}`,
    op,
    summary: `${op} summary`,
    risk: 'observe' as const,
    captured_at: '2026-06-24T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isDryRunSafe
// ---------------------------------------------------------------------------

describe('isDryRunSafe', () => {
  it('returns true for observe-only recording', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('snapshot'),
        makeAction('extract_text_ref'),
        makeAction('wait_for_ref'),
      ],
    };
    expect(isDryRunSafe(rec)).toBe(true);
  });

  it('returns false when any action is not read-only', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('snapshot'),
        makeAction('click_ref', { risk: 'low' }),
      ],
    };
    expect(isDryRunSafe(rec)).toBe(false);
  });

  it('returns true for empty recording', () => {
    expect(isDryRunSafe({ ...BASE_RECORDING, actions: [] })).toBe(true);
  });

  it('returns false when submit_form is present', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [makeAction('submit_form', { risk: 'high' })],
    };
    expect(isDryRunSafe(rec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compileBrowserRecording — basic shape
// ---------------------------------------------------------------------------

describe('compileBrowserRecording', () => {
  const OPTS = { intentPhrases: ['勤怠の承認'] };

  it('throws when intentPhrases is empty', () => {
    expect(() => compileBrowserRecording(BASE_RECORDING, { intentPhrases: [] })).toThrow(
      'intentPhrases must be non-empty',
    );
  });

  it('produces a valid ProcedureEntry with substrate=browser', () => {
    const result = compileBrowserRecording(BASE_RECORDING, OPTS);
    expect(result.procedureEntry.substrate).toBe('browser');
    expect(result.procedureEntry.adapter.recorder).toBe('chrome-extension');
    expect(result.procedureEntry.adapter.executor).toBe('extension_session');
    expect(result.procedureEntry.execution_substrate).toBe('extension');
    expect(result.procedureEntry.intent_phrases).toEqual(['勤怠の承認']);
    expect(result.procedureEntry.status).toBe('active');
  });

  it('uses tab.origin as target.origins[0]', () => {
    const result = compileBrowserRecording(BASE_RECORDING, OPTS);
    expect(result.procedureEntry.target.origins).toContain('https://s2.kingtime.jp');
  });

  it('collects all touched origins from navigate handoffs into target.origins', () => {
    const rec: BrowserExtensionRecording = {
      ...BASE_RECORDING,
      actions: [
        makeAction('click_ref', { risk: 'low' }),
        makeAction('navigate', {
          navigation: { from_origin: 'https://s2.kingtime.jp', to_origin: 'https://news.yahoo.co.jp' },
        }),
        makeAction('click_ref', { risk: 'low' }),
      ],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.procedureEntry.target.origins).toEqual([
      'https://s2.kingtime.jp',
      'https://news.yahoo.co.jp',
    ]);
  });

  it('treats navigate as read-only (does not bump risk_class)', () => {
    const rec: BrowserExtensionRecording = {
      ...BASE_RECORDING,
      actions: [
        makeAction('navigate', {
          navigation: { from_origin: 'https://a.example', to_origin: 'https://b.example' },
        }),
      ],
    };
    expect(compileBrowserRecording(rec, OPTS).procedureEntry.risk_class).toBe('low');
  });

  it('carries navigation onto the compiled step', () => {
    const rec: BrowserExtensionRecording = {
      ...BASE_RECORDING,
      actions: [
        makeAction('navigate', {
          navigation: { from_origin: 'https://a.example', to_origin: 'https://b.example' },
        }),
      ],
    };
    const step = compileBrowserRecording(rec, OPTS).compiledSteps.find((s) => s.op === 'navigate');
    expect(step?.navigation).toEqual({ from_origin: 'https://a.example', to_origin: 'https://b.example' });
  });

  it('uses tab.title as target.name when targetName not provided', () => {
    const result = compileBrowserRecording(BASE_RECORDING, OPTS);
    expect(result.procedureEntry.target.name).toBe('King of Time');
  });

  it('uses provided targetName over tab.title', () => {
    const result = compileBrowserRecording(BASE_RECORDING, {
      ...OPTS,
      targetName: 'Custom Service Name',
    });
    expect(result.procedureEntry.target.name).toBe('Custom Service Name');
  });

  it('derives risk_class from approval_required_count', () => {
    const rec = {
      ...BASE_RECORDING,
      risk_summary: { ...BASE_RECORDING.risk_summary, approval_required_count: 1 },
      actions: [makeAction('submit_form', { risk: 'high' })],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.procedureEntry.risk_class).toBe('high');
  });

  it('derives risk_class=medium for write ops without high-risk count', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [makeAction('click_ref', { risk: 'low' })],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.procedureEntry.risk_class).toBe('medium');
  });

  it('derives risk_class=low for all-observe recording', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [makeAction('snapshot'), makeAction('extract_text_ref')],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.procedureEntry.risk_class).toBe('low');
  });

  it('honours procedureId override', () => {
    const result = compileBrowserRecording(BASE_RECORDING, {
      ...OPTS,
      procedureId: 'my.custom.id',
    });
    expect(result.procedureEntry.procedure_id).toBe('my.custom.id');
  });

  it('builds pipelineRef from procedureId', () => {
    const result = compileBrowserRecording(BASE_RECORDING, {
      ...OPTS,
      procedureId: 'attendance.approve',
    });
    expect(result.procedureEntry.pipeline_ref).toBe(
      'pipelines/browser/attendance.approve.json',
    );
  });

  it('honours pipelineRefPrefix', () => {
    const result = compileBrowserRecording(BASE_RECORDING, {
      ...OPTS,
      procedureId: 'x',
      pipelineRefPrefix: 'custom/prefix/',
    });
    expect(result.procedureEntry.pipeline_ref).toBe('custom/prefix/x.json');
  });

  // -------------------------------------------------------------------------
  // compiledSteps
  // -------------------------------------------------------------------------

  it('omits sensitive_input_omitted actions from compiled steps', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('click_ref', { risk: 'low' }),
        makeAction('sensitive_input_omitted', { risk: 'sensitive' }),
        makeAction('snapshot'),
      ],
      risk_summary: { requires_manual_review: true, sensitive_input_omitted: 1, approval_required_count: 0 },
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.compiledSteps).toHaveLength(2);
    expect(result.compiledSteps.every((s) => s.op !== 'sensitive_input_omitted')).toBe(true);
  });

  it('preserves step_index in order', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [makeAction('snapshot'), makeAction('extract_text_ref'), makeAction('click_ref', { risk: 'low' })],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.compiledSteps.map((s) => s.step_index)).toEqual([0, 1, 2]);
  });

  it('propagates target ref/role/name to compiled step', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('click_ref', {
          risk: 'low',
          target: { ref: 'ref-42', role: 'button', name: '承認', snapshot_hash: 'abc' },
        }),
      ],
    };
    const step = compileBrowserRecording(rec, OPTS).compiledSteps[0];
    expect(step.ref).toBe('ref-42');
    expect(step.role).toBe('button');
    expect(step.name).toBe('承認');
  });

  // -------------------------------------------------------------------------
  // GoldenScenario
  // -------------------------------------------------------------------------

  it('produces a GoldenScenario referencing the recording_id', () => {
    const result = compileBrowserRecording(BASE_RECORDING, OPTS);
    expect(result.goldenScenario.schema_version).toBe('golden-scenario.v1');
    expect(result.goldenScenario.captured_from).toBe('rec-001');
    expect(result.goldenScenario.success_conditions.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts text_present condition from extract_text_ref at the end', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('click_ref', { risk: 'low' }),
        makeAction('extract_text_ref', {
          target: { ref: 'r1', role: 'cell', name: '承認完了', snapshot_hash: 'h1' },
        }),
      ],
    };
    const { goldenScenario } = compileBrowserRecording(rec, OPTS);
    const textCond = goldenScenario.success_conditions.find((c) => c.kind === 'text_present');
    expect(textCond).toBeDefined();
    expect(textCond?.name_contains).toBe('承認完了');
  });

  it('extracts ref_visible condition from wait_for_ref', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [
        makeAction('wait_for_ref', {
          target: { ref: 'r2', role: 'dialog', name: '確認ダイアログ', snapshot_hash: 'h2' },
        }),
      ],
    };
    const { goldenScenario } = compileBrowserRecording(rec, OPTS);
    const refCond = goldenScenario.success_conditions.find((c) => c.kind === 'ref_visible');
    expect(refCond?.role).toBe('dialog');
    expect(refCond?.name_contains).toBe('確認ダイアログ');
  });

  // -------------------------------------------------------------------------
  // isDryRunSafe + warnings
  // -------------------------------------------------------------------------

  it('marks isDryRunSafe=false and adds warning for write ops', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [makeAction('click_ref', { risk: 'low' }), makeAction('submit_form', { risk: 'high' })],
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.isDryRunSafe).toBe(false);
    expect(result.warnings.some((w) => w.includes('dry-run'))).toBe(true);
  });

  it('adds warning when sensitive inputs were omitted', () => {
    const rec = {
      ...BASE_RECORDING,
      actions: [],
      risk_summary: { requires_manual_review: true, sensitive_input_omitted: 2, approval_required_count: 0 },
    };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.warnings.some((w) => w.includes('sensitive'))).toBe(true);
  });

  it('no warnings for a clean observe-only recording', () => {
    const rec = { ...BASE_RECORDING, actions: [makeAction('snapshot')] };
    const result = compileBrowserRecording(rec, OPTS);
    expect(result.warnings).toHaveLength(0);
  });
});
