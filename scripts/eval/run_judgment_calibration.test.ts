import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  resolveCalibration,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  type JudgmentQuestion,
} from '@agent/core';
import { main, mergeCalibrationEntry, runJudgmentCalibration } from './run_judgment_calibration.js';

const TMP_DIR = path.join(process.cwd(), 'active/shared/tmp/test-judgment-calibration');

afterEach(() => {
  resetJudgmentBackends();
  safeRmSync(TMP_DIR, { recursive: true, force: true });
});

describe('run_judgment_calibration', () => {
  it('refuses small synthetic suites and does not write calibration file even with apply=true', async () => {
    registerJudgmentBackend({
      judgment_id: 'mock-deterministic-judge',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: async (req) =>
        req.questions.map((q) => ({
          id: q.id,
          value: 'retry',
          confidence: 0.9,
          calibrated: false,
        })),
    });

    safeMkdir(TMP_DIR, { recursive: true });
    const calibrationPath = path.join(TMP_DIR, 'judgment-calibration.json');

    const res = await runJudgmentCalibration({
      provider: 'mock-deterministic-judge',
      suite: 'semantic_decide',
      repeats: 2,
      apply: true,
      calibrationFilePath: calibrationPath,
      skipBootstrap: true,
    });

    expect(res.proposal.accepted).toBe(false);
    expect(res.applied).toBe(false);
    expect(safeExistsSync(calibrationPath)).toBe(false);
  });

  it('writes an accepted fit when deterministic samples satisfy calibration thresholds and merges cleanly', async () => {
    registerJudgmentBackend({
      judgment_id: 'mock-calibratable-judge',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: async (req) => {
        const text = typeof req.state === 'string' ? req.state : '';
        return req.questions.map((q) => ({
          id: q.id,
          value: text.startsWith('good') ? 'retry' : 'abort',
          confidence: text.startsWith('good') ? 0.92 : 0.88,
          calibrated: false,
        }));
      },
    });

    const cases = Array.from({ length: 20 }, (_, i) => ({
      id: `case-${i}`,
      state: i < 10 ? `good-${i}` : `bad-${i}`,
      expected: i < 10 ? 'retry' : 'abort',
    }));
    const question: JudgmentQuestion = {
      kind: 'choice',
      id: 'semantic_decide.option',
      options: ['retry', 'abort'],
      instructions: 'Pick retry or abort',
    };

    safeMkdir(TMP_DIR, { recursive: true });
    const calibrationPath = path.join(TMP_DIR, 'judgment-calibration.json');

    const res = await runJudgmentCalibration({
      provider: 'mock-calibratable-judge',
      customSpec: {
        questionId: 'semantic_decide.option',
        question: () => question,
        cases,
      },
      repeats: 2,
      minSamples: 20,
      minPerBin: 5,
      maxEce: 0.15,
      requireDeterministic: true,
      apply: true,
      calibrationFilePath: calibrationPath,
      skipBootstrap: true,
    });

    expect(res.proposal.accepted).toBe(true);
    expect(res.applied).toBe(true);
    expect(safeExistsSync(calibrationPath)).toBe(true);

    const written = JSON.parse(String(safeReadFile(calibrationPath, { encoding: 'utf8' }))) as {
      providers: Record<string, { questions: string[]; temperatures: Record<string, number> }>;
    };
    expect(written.providers['mock-calibratable-judge'].questions).toContain(
      'semantic_decide.option'
    );

    const merged = JSON.parse(
      mergeCalibrationEntry(JSON.stringify(written), 'mock-calibratable-judge', {
        questions: ['error.category'],
        fitted_from: 'builtin:error',
        fitted_at: '2026-11-28T00:00:00.000Z',
        temperatures: { 'error.category': 1.1 },
      })
    ) as {
      providers: Record<string, { questions: string[]; temperatures: Record<string, number> }>;
    };
    expect(merged.providers['mock-calibratable-judge'].questions).toEqual([
      'semantic_decide.option',
      'error.category',
    ]);
    expect(merged.providers['mock-calibratable-judge'].temperatures['error.category']).toBe(1.1);
    expect(resolveCalibration('builtin-rules', 'semantic_decide.option')).toBe(false);
  });

  it('refuses apply on provider mismatch, validates CLI flags, formats NaN-free output, and supports routing corpus + --output', async () => {
    registerJudgmentBackend({
      judgment_id: 'other-provider',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: async (req) =>
        req.questions.map((q) => ({
          id: q.id,
          value: 'small',
          confidence: 0.9,
          calibrated: false,
        })),
    });
    registerJudgmentBackend({
      judgment_id: 'requested-provider',
      egress: 'local-only',
      supports: () => false,
      judge: async () => [],
    });

    safeMkdir(TMP_DIR, { recursive: true });
    const ledgerPath = path.join(TMP_DIR, 'routing-outcomes.jsonl');
    const outPath = path.join(TMP_DIR, 'report.txt');
    const lines = Array.from({ length: 12 }, (_, idx) =>
      JSON.stringify({
        task_excerpt: `mechanical task ${idx}`,
        baseline_tier: 'standard',
        chosen_tier: 'small',
        chosen_by: 'judgment',
        succeeded: true,
        recorded_at: '2026-11-28T00:00:00.000Z',
      })
    );
    safeWriteFile(ledgerPath, lines.join('\n') + '\n');

    const mismatch = await runJudgmentCalibration({
      provider: 'requested-provider',
      suite: 'routing',
      routingLedgerPath: ledgerPath,
      repeats: 1,
      minSamples: 5,
      minPerBin: 5,
      maxEce: 0.5,
      apply: true,
      calibrationFilePath: path.join(TMP_DIR, 'should-not-exist.json'),
      skipBootstrap: true,
    });
    expect(mismatch.proposal.accepted).toBe(false);
    expect(mismatch.proposal.reason).toContain('provider mismatch');
    expect(mismatch.applied).toBe(false);

    // Invalid CLI flags fail cleanly
    await expect(main(['--provider', 'laya-mlx', '--repeats', '0'], () => {})).rejects.toThrow(
      /Invalid --repeats/
    );
    await expect(main(['--provider', 'laya-mlx', '--tier', 'bogus'], () => {})).rejects.toThrow(
      /Invalid --tier/
    );
    await expect(main(['--provider', 'laya-mlx', '--max-ece', '2'], () => {})).rejects.toThrow(
      /Invalid --max-ece/
    );

    // Zero-answered run formats Accuracy: n/a (never NaN%) and writes --output
    resetJudgmentBackends();
    registerJudgmentBackend({
      judgment_id: 'failing-provider',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: async () => {
        throw new Error('offline failure');
      },
    });
    const printed: string[] = [];
    const status = await main(
      [
        '--provider',
        'failing-provider',
        '--suite',
        'routing',
        '--routing-ledger',
        ledgerPath,
        '--repeats',
        '1',
        '--output',
        outPath,
      ],
      (line) => printed.push(line),
      { preserveRegisteredBackends: true }
    );
    expect(status).toBe(0);
    expect(printed[0]).toContain('Accuracy: n/a | ECE: n/a');
    expect(printed[0]).not.toContain('NaN');
    expect(printed[0]).toContain('Errors: 12 (first: offline failure)');
    expect(printed[0]).toContain('Next:');
    expect(safeExistsSync(outPath)).toBe(true);
  });
});
