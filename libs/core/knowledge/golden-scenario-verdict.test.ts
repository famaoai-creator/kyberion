import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  evaluateGoldenScenario,
  goldenScenarioPathForCatalog,
  loadGoldenScenario,
  presentServiceChannels,
  saveGoldenScenario,
  snapshotElementsFromBrowserContext,
  type RunEvidence,
} from './golden-scenario-verdict.js';
import type { GoldenScenario, GoldenSuccessCondition, ProcedureEntry } from './procedure-types.js';

const scenario = (conditions: GoldenSuccessCondition[]): GoldenScenario => ({
  schema_version: 'golden-scenario.v1',
  scenario_id: 'gs-p1',
  procedure_id: 'p1',
  success_conditions: conditions,
  captured_from: 'rec-1',
  version: '1.0.0',
});

const verdictOf = (conditions: GoldenSuccessCondition[], evidence: RunEvidence) =>
  evaluateGoldenScenario(scenario(conditions), evidence).verdict;

const service = (results: Array<{ status: 'done' | 'error'; produced?: string }>): RunEvidence => ({
  substrate: 'service',
  serviceResults: results.map((result, index) => ({
    step_id: `s${index + 1}`,
    service_id: 'jira',
    action: 'create_issue',
    ...result,
  })),
});

const page = (
  elements: Array<{ role: string; name?: string; text?: string; visible?: boolean }>
): RunEvidence => ({
  substrate: 'browser',
  snapshotElements: elements,
});

describe('evaluateGoldenScenario', () => {
  const issueKey: GoldenSuccessCondition = {
    kind: 'response_field',
    params: { channel: 'issue_key' },
  };
  const lastResult: GoldenSuccessCondition = {
    kind: 'response_field',
    params: { anchor: 'last_service_result' },
  };

  it('passes when a strong condition is met and nothing is unmet', () => {
    expect(verdictOf([issueKey], service([{ status: 'done', produced: 'issue_key' }]))).toBe(
      'pass'
    );
  });

  it('fails when a producing step did not finish, or nothing produced the value', () => {
    expect(verdictOf([issueKey], service([{ status: 'error', produced: 'issue_key' }]))).toBe(
      'fail'
    );
    expect(verdictOf([issueKey], service([{ status: 'done' }]))).toBe('fail');
  });

  it('fails a step that finished but returned an empty value', () => {
    const evidence = { ...service([{ status: 'done', produced: 'issue_key' }]) };
    expect(verdictOf([issueKey], { ...evidence, serviceChannelsPresent: [] })).toBe('fail');
    expect(verdictOf([issueKey], { ...evidence, serviceChannelsPresent: ['issue_key'] })).toBe(
      'pass'
    );
    expect(presentServiceChannels({ a: '', b: {}, c: [], d: null, e: 'JIRA-1', f: 0 })).toEqual([
      'e',
      'f',
    ]);
  });

  it('never passes on weak fallback conditions alone', () => {
    expect(verdictOf([lastResult], service([{ status: 'done' }]))).toBe('inconclusive');
    expect(verdictOf([lastResult], service([{ status: 'error' }]))).toBe('fail');
    expect(verdictOf([{ kind: 'ref_visible', role: 'button' }], page([{ role: 'button' }]))).toBe(
      'inconclusive'
    );
    // The control the run just clicked still being visible says nothing about success.
    expect(
      verdictOf(
        [
          {
            kind: 'ref_visible',
            role: 'button',
            name_contains: 'Approve',
            params: { anchor: 'last_action_target' },
          },
        ],
        page([{ role: 'button', name: 'Approve' }])
      )
    ).toBe('inconclusive');
  });

  it('is inconclusive when the evidence does not cover the conditions', () => {
    expect(verdictOf([issueKey], page([]))).toBe('inconclusive');
    expect(
      verdictOf([{ kind: 'screenshot_state', params: { anchor: 'recording_end' } }], page([]))
    ).toBe('inconclusive');
    expect(
      verdictOf([{ kind: 'ref_visible', name_contains: 'Done' }], { substrate: 'browser' })
    ).toBe('inconclusive');
  });

  it('a met strong condition passes even alongside an unchecked one', () => {
    expect(
      verdictOf(
        [issueKey, { kind: 'file_generated', params: { path: 'out.pdf' } }],
        service([{ status: 'done', produced: 'issue_key' }])
      )
    ).toBe('pass');
  });

  it('ref_visible needs a visible match with the right role; text_present does not need visibility', () => {
    const approved: GoldenSuccessCondition = {
      kind: 'ref_visible',
      role: 'status',
      name_contains: 'approved',
    };
    expect(verdictOf([approved], page([{ role: 'status', name: 'Request Approved' }]))).toBe(
      'pass'
    );
    expect(
      verdictOf([approved], page([{ role: 'status', name: 'Request Approved', visible: false }]))
    ).toBe('fail');
    expect(verdictOf([approved], page([{ role: 'alert', name: 'Request Approved' }]))).toBe('fail');
    expect(
      verdictOf(
        [{ kind: 'text_present', name_contains: 'total: 3' }],
        page([{ role: 'cell', text: 'Total: 3', visible: false }])
      )
    ).toBe('pass');
  });

  it('reports which condition failed', () => {
    const result = evaluateGoldenScenario(scenario([issueKey]), service([{ status: 'done' }]));
    expect(result.conditions[0]).toMatchObject({
      outcome: 'unmet',
      detail: 'nothing produced issue_key',
    });
  });
});

describe('golden scenario storage', () => {
  const root = pathResolver.sharedTmp(`golden-store-test-${process.pid}`);
  afterEach(() => safeRmSync(root, { recursive: true, force: true }));

  const procedure = (ref: string): ProcedureEntry => ({
    procedure_id: 'p1',
    substrate: 'service',
    adapter: { recorder: 'service-capture', executor: 'service:preset' },
    target: { name: 'T' },
    intent_phrases: ['do it'],
    pipeline_ref: 'pipelines/service/p1.json',
    risk_class: 'low',
    version: '1.0.0',
    status: 'active',
    golden_scenario_ref: ref,
  });

  it('stores the golden scenario next to the catalog and loads it back', () => {
    const goldenPath = goldenScenarioPathForCatalog(
      path.join(root, 'procedures.json'),
      'p1',
      '1.0.0'
    );
    expect(goldenPath).toBe(path.join(root, 'golden', 'p1.v1.0.0.json'));
    const ref = saveGoldenScenario(
      scenario([{ kind: 'response_field', params: { channel: 'x' } }]),
      goldenPath
    );
    expect(loadGoldenScenario(procedure(ref))?.scenario_id).toBe('gs-p1');
  });

  it('refuses an invalid scenario and ignores one recorded for another procedure', () => {
    const goldenPath = path.join(root, 'golden', 'bad.json');
    expect(() => saveGoldenScenario(scenario([]), goldenPath)).toThrow();
    const ref = saveGoldenScenario(
      {
        ...scenario([{ kind: 'response_field', params: { channel: 'x' } }]),
        procedure_id: 'other',
      },
      goldenPath
    );
    expect(loadGoldenScenario(procedure(ref))).toBeUndefined();
    expect(loadGoldenScenario(procedure('knowledge/personal/golden/missing.json'))).toBeUndefined();
  });

  it('reads snapshot elements defensively from a browser run context', () => {
    expect(snapshotElementsFromBrowserContext(undefined)).toBeUndefined();
    expect(
      snapshotElementsFromBrowserContext({ golden_final_snapshot: { elements: 'x' } })
    ).toBeUndefined();
    expect(
      snapshotElementsFromBrowserContext({
        golden_final_snapshot: { elements: [{ role: 'button', name: 'OK', visible: false }, null] },
      })
    ).toEqual([{ role: 'button', name: 'OK', text: null, visible: false }]);
  });
});
