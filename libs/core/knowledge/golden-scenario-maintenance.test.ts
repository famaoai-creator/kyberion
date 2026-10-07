import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  backfillGoldenScenarios,
  goldenScenarioIsWeakOnly,
  procedureCheckStatus,
} from './golden-scenario-maintenance.js';
import { loadGoldenScenario, saveGoldenScenario } from './golden-scenario-verdict.js';
import { recordKnowledgeProblem, recordKnowledgeVerifiedRun } from './knowledge-verification.js';
import type { GoldenSuccessCondition, ProcedureEntry } from './procedure-types.js';

const root = pathResolver.sharedTmp(`golden-maintenance-${process.pid}`);
const feedbackDir = pathResolver.sharedTmp(`golden-maintenance-feedback-${process.pid}`);
const recordingStore = pathResolver.shared('runtime/recordings');
const recordingName = `golden-maintenance-${process.pid}.json`;
const recordingRef = pathResolver.toRepoRelative(path.join(recordingStore, recordingName));
const catalogPath = path.join(root, 'procedures.json');
let savedFeedbackDir: string | undefined;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function recordingWith(actions: Array<Record<string, unknown>>) {
  return {
    schema_version: 'browser-recording.v1',
    recording_id: 'REC-maint-1',
    source: 'chrome-extension',
    created_at: '2026-10-07T00:00:00.000Z',
    tab: {
      origin: 'https://example.com',
      origin_hash: hash('https://example.com'),
      title: 'Example',
    },
    extension: { version: '0.1.0' },
    actions: actions.map((action, index) => ({
      action_id: `step-${index + 1}`,
      risk: 'low',
      captured_at: '2026-10-07T00:00:01.000Z',
      ...action,
    })),
    risk_summary: {
      requires_manual_review: true,
      sensitive_input_omitted: 0,
      approval_required_count: 0,
    },
    review: {
      status: 'approved',
      decisions: actions.map((_, index) => ({
        action_id: `step-${index + 1}`,
        status: 'approved',
      })),
    },
  };
}

const click = {
  op: 'click_ref',
  summary: 'Approve を選択',
  target: { ref: '@e1', role: 'button', name: 'Approve', snapshot_hash: hash('s1') },
};
const waitForDone = {
  op: 'wait_for_ref',
  summary: '完了表示を待つ',
  target: { ref: '@e2', role: 'status', name: 'Approved', snapshot_hash: hash('s2') },
};

function entry(id: string, overrides: Partial<ProcedureEntry> = {}): ProcedureEntry {
  return {
    procedure_id: id,
    substrate: 'browser',
    adapter: {
      recorder: 'chrome-extension',
      executor: 'extension_session',
      recording_ref: recordingRef,
    },
    target: { name: 'Example', origins: ['https://example.com'] },
    intent_phrases: ['approve the request'],
    pipeline_ref: `pipelines/browser/${id}.json`,
    risk_class: 'low',
    version: '1.0.0',
    status: 'active',
    ...overrides,
  };
}

function writeCatalog(procedures: ProcedureEntry[]): void {
  safeWriteFile(catalogPath, JSON.stringify({ schema_version: 'procedures.v1', procedures }));
}

beforeEach(() => {
  savedFeedbackDir = process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = feedbackDir;
  safeMkdir(root, { recursive: true });
  safeMkdir(recordingStore, { recursive: true });
});

afterEach(() => {
  if (savedFeedbackDir === undefined) delete process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  else process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = savedFeedbackDir;
  safeRmSync(path.join(recordingStore, recordingName), { force: true });
  safeRmSync(root, { recursive: true, force: true });
  safeRmSync(feedbackDir, { recursive: true, force: true });
});

describe('backfillGoldenScenarios', () => {
  it('creates the missing golden scenario from the recording and links it', () => {
    safeWriteFile(
      path.join(recordingStore, recordingName),
      JSON.stringify(recordingWith([click, waitForDone]))
    );
    writeCatalog([entry('maint.approve', { version: '1.2.0' })]);

    const results = backfillGoldenScenarios({ catalogPath });

    expect(results).toEqual([
      expect.objectContaining({
        procedure_id: 'maint.approve',
        action: 'created',
        weak_only: false,
      }),
    ]);
    const saved = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string)
      .procedures[0];
    expect(saved.golden_scenario_ref).toBe(results[0].golden_scenario_ref);
    const scenario = loadGoldenScenario(saved);
    expect(scenario).toMatchObject({ procedure_id: 'maint.approve', version: '1.2.0' });
    expect(scenario?.success_conditions[0]).toMatchObject({
      kind: 'ref_visible',
      name_contains: 'Approved',
    });
    expect(backfillGoldenScenarios({ catalogPath })).toEqual([]);
  });

  it('flags a scenario built only from the last-action fallback as weak only', () => {
    safeWriteFile(path.join(recordingStore, recordingName), JSON.stringify(recordingWith([click])));
    writeCatalog([entry('maint.click')]);
    expect(backfillGoldenScenarios({ catalogPath })[0]).toMatchObject({
      action: 'created',
      weak_only: true,
    });
  });

  it('writes nothing on a dry run', () => {
    safeWriteFile(
      path.join(recordingStore, recordingName),
      JSON.stringify(recordingWith([click, waitForDone]))
    );
    writeCatalog([entry('maint.approve')]);
    const before = safeReadFile(catalogPath, { encoding: 'utf8' });
    const [result] = backfillGoldenScenarios({ catalogPath, dryRun: true });
    expect(result.action).toBe('would_create');
    expect(safeReadFile(catalogPath, { encoding: 'utf8' })).toBe(before);
    expect(safeExistsSync(path.join(root, 'golden'))).toBe(false);
  });

  it('skips procedures it cannot rebuild, and leaves the catalog alone when nothing changed', () => {
    writeCatalog([
      entry('maint.missing'),
      entry('maint.desktop', {
        substrate: 'desktop',
        adapter: { recorder: 'desktop', executor: 'desktop' },
      }),
    ]);
    const before = safeReadFile(catalogPath, { encoding: 'utf8' });
    const results = backfillGoldenScenarios({ catalogPath });
    expect(results.map((result) => [result.procedure_id, result.action])).toEqual([
      ['maint.missing', 'skipped'],
      ['maint.desktop', 'skipped'],
    ]);
    expect(results[1].reason).toContain('desktop');
    expect(safeReadFile(catalogPath, { encoding: 'utf8' })).toBe(before);
  });
});

describe('procedureCheckStatus', () => {
  const docRef = pathResolver.toRepoRelative(path.join(root, 'recording-doc.json'));

  function withGolden(id: string, conditions: GoldenSuccessCondition[]): ProcedureEntry {
    const ref = saveGoldenScenario(
      {
        schema_version: 'golden-scenario.v1',
        scenario_id: `gs-${id}`,
        procedure_id: id,
        success_conditions: conditions,
        captured_from: 'REC-maint-1',
        version: '1.0.0',
      },
      path.join(root, 'golden', `${id}.json`)
    );
    return entry(id, {
      adapter: {
        recorder: 'chrome-extension',
        executor: 'extension_session',
        recording_ref: docRef,
      },
      golden_scenario_ref: ref,
    });
  }

  const strong: GoldenSuccessCondition[] = [
    { kind: 'ref_visible', role: 'status', name_contains: 'Approved' },
  ];

  it('says what each procedure needs, failures first', () => {
    safeWriteFile(path.join(root, 'recording-doc.json'), '{"v":1}\n');
    const passing = withGolden('maint.passing', strong);
    const failing = {
      ...withGolden('maint.failing', strong),
      pipeline_ref: 'pipelines/browser/f.json',
    };
    const failingDoc = pathResolver.toRepoRelative(path.join(root, 'failing-doc.json'));
    safeWriteFile(path.join(root, 'failing-doc.json'), '{"v":1}\n');
    failing.adapter = { ...failing.adapter, recording_ref: failingDoc };
    recordKnowledgeVerifiedRun({ documentPaths: [docRef], evidence: 'golden' });
    recordKnowledgeProblem({ documentPath: failingDoc, kind: 'failed_check', reason: 'not found' });

    const rows = procedureCheckStatus({
      procedures: [
        passing,
        failing,
        entry('maint.nogolden', { adapter: { recorder: 'x', executor: 'extension_session' } }),
        withGolden('maint.weak', [{ kind: 'ref_visible', role: 'button' }]),
      ],
    });

    expect(rows.map((row) => [row.procedure_id, row.verification, row.attention])).toEqual([
      ['maint.failing', 'failed_check', ['failed_check']],
      ['maint.nogolden', 'none', ['no_golden_scenario']],
      ['maint.weak', 'passed_check', ['weak_only']],
      ['maint.passing', 'passed_check', []],
    ]);
  });

  it('weak-only detection matches the verdict rules', () => {
    const scenario = (conditions: GoldenSuccessCondition[]) => ({
      schema_version: 'golden-scenario.v1' as const,
      scenario_id: 'gs',
      procedure_id: 'p',
      success_conditions: conditions,
      captured_from: 'r',
      version: '1.0.0',
    });
    expect(goldenScenarioIsWeakOnly(scenario(strong))).toBe(false);
    expect(
      goldenScenarioIsWeakOnly(
        scenario([
          {
            kind: 'ref_visible',
            name_contains: 'Approve',
            params: { anchor: 'last_action_target' },
          },
        ])
      )
    ).toBe(true);
    expect(goldenScenarioIsWeakOnly(scenario([{ kind: 'screenshot_state' }]))).toBe(true);
  });
});
