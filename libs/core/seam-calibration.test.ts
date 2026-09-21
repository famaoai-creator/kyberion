import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import {
  registerSeamCalibrationAdapter,
  runSeamCalibration,
  suggestTraitValues,
} from './seam-calibration.js';

const outRoot = pathResolver.sharedTmp('seam-calibration-test');

describe('seam calibration', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    safeRmSync(outRoot, { recursive: true, force: true });
  });

  it('runs eligible candidates, skips opt-in ones, and writes a report with suggested traits', async () => {
    const calls: string[] = [];
    dispose = registerSeamCalibrationAdapter<{ text: string }>({
      seam: 'test-seam',
      description: 'test',
      input_example: { text: 'hello' },
      listCandidates: async () => [
        { id: 'fast', eligible: true },
        { id: 'slow', eligible: true },
        { id: 'cloud', eligible: true },
        { id: 'broken', eligible: false, unmet: ['not installed'] },
      ],
      runTrial: async (id, input) => {
        calls.push(id);
        return {
          ok: true,
          output: { text: `${id}:${input.text}` },
          metrics: { char_error_rate: id === 'fast' ? 0.3 : 0.1 },
        };
      },
      trait_mappings: {
        speed: { metric: 'latency_ms', higher_is_better: false },
        accuracy: { metric: 'char_error_rate', higher_is_better: false },
      },
      requiresExplicitOptIn: (id) => id === 'cloud',
    });
    const clock = { fast: 10, slow: 50 } as Record<string, number>;
    let current = 0;
    let lastId = '';
    const report = await runSeamCalibration({
      seam: 'test-seam',
      input: { text: 'hello' },
      repeats: 2,
      outRoot,
      runId: 'run-1',
      now: () => {
        // runTrial pushes its id before the second clock read
        const id = calls[calls.length - 1] ?? '';
        if (id !== lastId) lastId = id;
        current += clock[id] ?? 0;
        return current;
      },
    });
    expect(calls).toEqual(['fast', 'fast', 'slow', 'slow']);
    const byId = Object.fromEntries(report.providers.map((p) => [p.provider_id, p]));
    expect(byId.cloud!.skipped_reason).toMatch(/--providers/);
    expect(byId.broken!.eligible).toBe(false);
    expect(byId.fast!.success_rate).toBe(1);
    expect(report.suggested_traits.accuracy).toEqual({ fast: 0, slow: 1 });
    expect(report.input).toEqual({ text: '[redacted]' });
    expect(byId.fast!.runs[0]!.output).toEqual({ text: '[redacted]' });
    const json = path.join(pathResolver.rootDir(), report.report_json);
    const md = path.join(pathResolver.rootDir(), report.report_markdown);
    expect(safeExistsSync(json)).toBe(true);
    expect(String(safeReadFile(md, { encoding: 'utf8' }))).toMatch(
      /pnpm kyberion seam select rules set/
    );
  });

  it('includes opt-in providers only when listed explicitly', async () => {
    const calls: string[] = [];
    dispose = registerSeamCalibrationAdapter({
      seam: 'test-seam',
      description: 'test',
      input_example: {},
      listCandidates: async () => [
        { id: 'local', eligible: true },
        { id: 'cloud', eligible: true },
      ],
      runTrial: async (id) => {
        calls.push(id);
        return { ok: id === 'cloud', error: id === 'cloud' ? undefined : 'boom' };
      },
      requiresExplicitOptIn: (id) => id === 'cloud',
    });
    const report = await runSeamCalibration({
      seam: 'test-seam',
      input: {},
      providers: ['cloud'],
      outRoot,
      runId: 'run-2',
    });
    expect(calls).toEqual(['cloud']);
    expect(report.providers.find((p) => p.provider_id === 'local')!.skipped_reason).toMatch(
      /not selected/
    );
  });

  it('normalises metrics across providers and needs two data points', () => {
    const summary = (id: string, latency: number) => ({
      provider_id: id,
      eligible: true,
      runs: [],
      success_rate: 1,
      latency_ms_median: latency,
      metrics_mean: {},
    });
    expect(
      suggestTraitValues([summary('a', 100), summary('b', 300), summary('c', 200)], {
        speed: { metric: 'latency_ms', higher_is_better: false },
      })
    ).toEqual({ speed: { a: 1, b: 0, c: 0.5 } });
    expect(
      suggestTraitValues([summary('a', 100)], {
        speed: { metric: 'latency_ms', higher_is_better: false },
      })
    ).toEqual({});
  });

  it('fails clearly for a seam without an adapter', async () => {
    await expect(runSeamCalibration({ seam: 'nope', input: {}, outRoot })).rejects.toThrow(
      /no calibration adapter/
    );
  });

  it('treats providers that measure the same as equally good', () => {
    const summary = (id: string) => ({
      provider_id: id,
      eligible: true,
      runs: [],
      success_rate: 1,
      latency_ms_median: 100,
      metrics_mean: { char_error_rate: 0 },
    });
    expect(
      suggestTraitValues([summary('a'), summary('b')], {
        accuracy: { metric: 'char_error_rate', higher_is_better: false },
      })
    ).toEqual({ accuracy: { a: 1, b: 1 } });
  });
});
