import { describe, expect, it } from 'vitest';
import { proposeWorkDecomposition } from './work-inventory-decompose.js';
import { validateWorkInventoryEntry } from './work-inventory.js';
import type { ReasoningBackend } from './reasoning-backend.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');

function fakeBackend(
  impl: (instruction: string, context?: string) => Promise<string>
): Pick<ReasoningBackend, 'delegateTask'> {
  return { delegateTask: impl };
}

const MONTHLY_SALES_REPORT_DESCRIPTION =
  'メールを開く → 添付Excelを保存 → 基幹システムにログイン → 売上CSVをダウンロード → Excelを開く → ' +
  '前月データと結合 → 異常値を探す → 理由をSlackで担当者に聞く → 回答を反映 → PowerPointを更新 → 部長にメールする';

describe('proposeWorkDecomposition — heuristic path (deterministic, no model)', () => {
  it('decomposes the monthly sales report example into the expected verb sequence', async () => {
    const result = await proposeWorkDecomposition(
      {
        title: '月次売上報告',
        description: MONTHLY_SALES_REPORT_DESCRIPTION,
        scope: {},
        systems: ['Slack'],
      },
      { useModel: false, now: NOW }
    );

    expect(result.source).toBe('heuristic');
    expect(result.entry.steps.map((step) => step.verb)).toEqual([
      'receive',
      'record',
      'operate',
      'operate',
      'operate',
      'transform',
      'judge',
      'communicate',
      'input',
      'create',
      'communicate',
    ]);
    // First step is a receive: forced to the trigger stage.
    expect(result.entry.steps[0].stage).toBe('trigger');
    // System detection against the supplied systems list.
    expect(result.entry.steps[7].system).toBe('Slack');
    // "email the manager" carries an external_send effect (communicate + メールする).
    expect(result.entry.steps[10].effects).toContain('external_send');
    expect(result.entry.steps[10].requires_review).toBe(true);

    const check = validateWorkInventoryEntry(result.entry);
    expect(check).toEqual({ valid: true, errors: [] });
  });

  it('falls back to heuristic and warns when the reasoning backend is the deterministic stub', async () => {
    const result = await proposeWorkDecomposition(
      {
        title: '月次売上報告',
        description: MONTHLY_SALES_REPORT_DESCRIPTION,
        scope: {},
      },
      { now: NOW } // useModel defaults true, but getReasoningBackend() resolves to stub in tests
    );

    expect(result.source).toBe('heuristic');
    expect(result.warnings.some((warning) => warning.includes('stub'))).toBe(true);
    expect(result.entry.steps.length).toBe(11);
  });

  it('decomposes an English description into a sensible, valid entry', async () => {
    const result = await proposeWorkDecomposition(
      {
        title: 'Invoice reconciliation',
        description:
          'Receive an email -> Download the CSV from the ERP -> merge with last month data -> ' +
          'decide if it is an anomaly -> Email the manager',
        scope: {},
        systems: ['ERP'],
      },
      { useModel: false, now: NOW }
    );

    expect(result.source).toBe('heuristic');
    expect(result.entry.steps).toHaveLength(5);
    expect(result.entry.steps[0].verb).toBe('receive');
    expect(result.entry.steps[1].verb).toBe('operate'); // "Download"
    expect(result.entry.steps[1].system).toBe('ERP');
    expect(result.entry.steps[2].verb).toBe('transform'); // "merge"
    expect(result.entry.steps[3].verb).toBe('judge'); // "decide ... anomaly"
    expect(result.entry.steps[4].verb).toBe('communicate'); // "Email the manager"

    const check = validateWorkInventoryEntry(result.entry);
    expect(check).toEqual({ valid: true, errors: [] });
  });

  it('caps the number of steps at 40 and warns about truncation', async () => {
    const fragments = Array.from({ length: 45 }, (_, i) => `ステップ${i + 1}を実施`);
    const result = await proposeWorkDecomposition(
      {
        title: 'long process',
        description: fragments.join(' → '),
        scope: {},
      },
      { useModel: false, now: NOW }
    );

    expect(result.entry.steps).toHaveLength(40);
    expect(result.warnings.some((warning) => warning.includes('truncated'))).toBe(true);
  });
});

describe('proposeWorkDecomposition — model path', () => {
  it('uses steps from a valid model JSON reply', async () => {
    const backend = fakeBackend(async () =>
      JSON.stringify({
        steps: [
          {
            stage: 'gather',
            verb: 'search',
            description: 'Search the shared drive for the invoice',
          },
          { verb: 'read', description: 'Read the invoice total' },
        ],
      })
    );

    const result = await proposeWorkDecomposition(
      { title: 'Invoice check', description: 'irrelevant, model supplies steps', scope: {} },
      { backend, now: NOW }
    );

    expect(result.source).toBe('model');
    expect(result.warnings).toEqual([]);
    expect(result.entry.steps).toHaveLength(2);
    expect(result.entry.steps[0]).toMatchObject({ stage: 'gather', verb: 'search' });
    expect(result.entry.steps[1]).toMatchObject({ stage: 'understand', verb: 'read' });
  });

  it('lets the rule engine override a model method proposal for a step with a money effect, keeping both reasons', async () => {
    const backend = fakeBackend(async () =>
      JSON.stringify({
        steps: [
          {
            verb: 'input',
            description: 'Submit the payment request',
            effects: ['money'],
            method_proposal: 'api',
            why: 'the payment system has an api',
          },
        ],
      })
    );

    const result = await proposeWorkDecomposition(
      { title: 'Payment request', description: 'irrelevant', scope: {} },
      { backend, now: NOW }
    );

    expect(result.source).toBe('model');
    const method = result.entry.steps[0].method;
    expect(method.assigned).toBe('human');
    expect(method.source).toBe('rule');
    expect(method.rationale).toContain('effects-force-human');
    expect(method.rationale).toContain('proposal was api: the payment system has an api');
  });

  it('drops invalid steps from the model reply but keeps the valid ones, with a warning', async () => {
    const backend = fakeBackend(async () =>
      JSON.stringify({
        steps: [
          { verb: 'not-a-real-verb', description: 'bogus' },
          { verb: 'read', description: '' }, // missing description
          { verb: 'read', description: 'Read the report' },
        ],
      })
    );

    const result = await proposeWorkDecomposition(
      { title: 'x', description: 'irrelevant', scope: {} },
      { backend, now: NOW }
    );

    expect(result.source).toBe('model');
    expect(result.entry.steps).toHaveLength(1);
    expect(result.entry.steps[0].verb).toBe('read');
    expect(result.warnings.some((warning) => warning.includes('dropped'))).toBe(true);
  });

  it('falls back to heuristic decomposition when the model reply is unusable garbage', async () => {
    const backend = fakeBackend(async () => 'Sure! Here are the steps: 1. do it 2. done.');

    const result = await proposeWorkDecomposition(
      { title: '月次売上報告', description: MONTHLY_SALES_REPORT_DESCRIPTION, scope: {} },
      { backend, now: NOW }
    );

    expect(result.source).toBe('heuristic');
    expect(result.warnings.some((warning) => warning.includes('unusable'))).toBe(true);
    expect(result.entry.steps.map((step) => step.verb)[0]).toBe('receive');
  });

  it('falls back to heuristic decomposition when the backend throws', async () => {
    const backend = fakeBackend(async () => {
      throw new Error('provider unavailable');
    });

    const result = await proposeWorkDecomposition(
      { title: '月次売上報告', description: MONTHLY_SALES_REPORT_DESCRIPTION, scope: {} },
      { backend, now: NOW }
    );

    expect(result.source).toBe('heuristic');
    expect(result.warnings.some((warning) => warning.includes('provider unavailable'))).toBe(true);
  });

  it('falls back to heuristic decomposition when the backend times out', async () => {
    const backend = fakeBackend(
      () => new Promise<string>(() => {}) // never resolves
    );

    const result = await proposeWorkDecomposition(
      { title: '月次売上報告', description: MONTHLY_SALES_REPORT_DESCRIPTION, scope: {} },
      { backend, now: NOW, timeoutMs: 20 }
    );

    expect(result.source).toBe('heuristic');
    expect(result.warnings.some((warning) => warning.toLowerCase().includes('timeout'))).toBe(true);
  });

  it('validates the produced entry', async () => {
    const backend = fakeBackend(async () =>
      JSON.stringify({
        steps: [{ verb: 'create', description: 'Draft the summary slide' }],
      })
    );

    const result = await proposeWorkDecomposition(
      { title: 'Slide draft', description: 'irrelevant', scope: {} },
      { backend, now: NOW }
    );

    const check = validateWorkInventoryEntry(result.entry);
    expect(check).toEqual({ valid: true, errors: [] });
  });
});
