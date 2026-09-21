import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Rule changes and decisions are audited; keep the real audit log untouched.
vi.mock('@agent/core/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { getSeamTraitOverrides } from '@agent/core/seam-selection-rules';
import { registerSeamCalibrationAdapter } from '@agent/core/seam-calibration';
import { ocrProviderCalibrationAdapter } from './lib/seam-calibration/ocr-provider.js';
import { runSeamSelection } from './seam_selection.js';

// Exercises the seam:select CLI end to end (list / explain / rules /
// apply-measurements / calibrate) with the real engine and governed policy
// files. Only the operator overlay path is redirected to a throwaway file
// under active/shared/tmp/ so nothing is written to a real operator profile.
const workDir = pathResolver.sharedTmp('seam-selection-cli-test');
const rulesFile = path.join(workDir, 'rules.json');

interface ListOutput {
  seams: Array<{ seam: string; purposes: string[]; calibration: boolean }>;
  calibration_adapters: Array<{ seam: string }>;
  rules: Array<{ rule_id: string }>;
}

/** Parsed CLI output; callers name the shape they read. */
type Json = Record<string, unknown>;

function lastPrintedJson<T = Json>(logSpy: ReturnType<typeof vi.spyOn>): T {
  const calls = logSpy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const raw = String(calls[i]![0] ?? '');
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Not a JSON line (e.g. an [INFO]/[SUCCESS] diagnostic) — keep looking.
    }
  }
  throw new Error('no JSON line was printed to console.log');
}

describe('seam_selection CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const calibrationRunDirs: string[] = [];

  beforeEach(() => {
    safeRmSync(workDir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    safeRmSync(workDir, { recursive: true, force: true });
    for (const dir of calibrationRunDirs.splice(0)) {
      safeRmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists seams, calibration adapters and (empty) operator rules', async () => {
    process.exitCode = undefined;
    await runSeamSelection(['list']);
    const printed = lastPrintedJson<ListOutput>(logSpy);

    const ocrSeam = printed.seams.find((s) => s.seam === 'ocr-provider');
    expect(ocrSeam).toMatchObject({ default_provider: 'apple_vision', calibration: true });
    expect(ocrSeam.purposes).toEqual(
      expect.arrayContaining(['accuracy', 'speed', 'privacy', 'cost'])
    );

    const browserSeam = printed.seams.find((s) => s.seam === 'browser-automation-runtime');
    expect(browserSeam).toMatchObject({
      default_provider: 'playwright-chromium',
      calibration: true,
    });

    expect(printed.calibration_adapters.map((a) => a.seam)).toEqual(
      expect.arrayContaining(['ocr-provider', 'browser-automation-runtime'])
    );
    expect(printed.rules).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('explains a purpose decision without recording or pinning anything', async () => {
    process.exitCode = undefined;
    await runSeamSelection([
      'explain',
      '--seam',
      'ocr-provider',
      '--purpose',
      'accuracy',
      '--eligible',
      'apple_vision,llm_api',
    ]);
    const decision = lastPrintedJson(logSpy);

    expect(decision.provider_id).toBe('llm_api');
    expect(decision.strategy).toBe('purpose');
    expect(decision.pinned).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('rejects an unknown seam with a helpful list of known seams', async () => {
    process.exitCode = undefined;
    await runSeamSelection(['explain', '--seam', 'not-a-real-seam', '--purpose', 'accuracy']);
    expect(process.exitCode).toBe(1);
  });

  it('sets, lists and removes an operator selection rule', async () => {
    process.exitCode = undefined;
    await runSeamSelection([
      'rules',
      'set',
      '--seam',
      'ocr-provider',
      '--rule-id',
      'cli-test-rule',
      '--purpose',
      'accuracy',
      '--prefer',
      'apple_vision',
      '--note',
      'cli test',
    ]);
    const setResult = lastPrintedJson(logSpy);
    expect(setResult.rule).toMatchObject({
      rule_id: 'cli-test-rule',
      seam: 'ocr-provider',
      prefer: ['apple_vision'],
    });

    await runSeamSelection(['rules', 'list', '--seam', 'ocr-provider']);
    const listed = lastPrintedJson<ListOutput>(logSpy);
    expect(listed.rules.map((r) => r.rule_id)).toContain('cli-test-rule');

    // The rule now wins over the purpose ranking that would otherwise pick llm_api.
    await runSeamSelection([
      'explain',
      '--seam',
      'ocr-provider',
      '--purpose',
      'accuracy',
      '--eligible',
      'apple_vision,llm_api',
    ]);
    const decision = lastPrintedJson(logSpy);
    expect(decision.provider_id).toBe('apple_vision');
    expect(decision.strategy).toBe('rule');
    expect(decision.rule_id).toBe('cli-test-rule');

    await runSeamSelection(['rules', 'remove', '--rule-id', 'cli-test-rule']);
    const removed = lastPrintedJson(logSpy);
    expect(removed).toEqual({ removed: 'cli-test-rule' });

    await runSeamSelection(['rules', 'list', '--seam', 'ocr-provider']);
    const listedAfter = lastPrintedJson(logSpy);
    expect(listedAfter.rules).toEqual([]);
  });

  it('rejects rules set with an unknown purpose or unknown provider', async () => {
    process.exitCode = undefined;
    await runSeamSelection([
      'rules',
      'set',
      '--seam',
      'ocr-provider',
      '--rule-id',
      'bad-purpose',
      '--purpose',
      'not-a-purpose',
      '--prefer',
      'apple_vision',
    ]);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await runSeamSelection([
      'rules',
      'set',
      '--seam',
      'ocr-provider',
      '--rule-id',
      'bad-provider',
      '--prefer',
      'not-a-provider',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('applies measured traits from a synthetic calibration report', async () => {
    process.exitCode = undefined;
    const reportPath = path.join(workDir, 'synthetic-report.json');
    safeWriteFile(
      reportPath,
      JSON.stringify({
        seam: 'ocr-provider',
        run_id: 'synthetic-run',
        created_at: new Date(0).toISOString(),
        input: { image_path: 'active/shared/tmp/does-not-matter.png' },
        repeats: 1,
        providers: [],
        suggested_traits: {
          accuracy: { apple_vision: 0.42, llm_api: 0.97 },
          latency: { apple_vision: 0.6, llm_api: 0.3 },
        },
        report_json: pathResolver.toRepoRelative(reportPath),
        report_markdown: pathResolver.toRepoRelative(reportPath),
      }),
      { encoding: 'utf8' }
    );

    await runSeamSelection([
      'apply-measurements',
      '--report',
      pathResolver.toRepoRelative(reportPath),
      '--traits',
      'accuracy',
    ]);
    const applied = lastPrintedJson(logSpy);
    expect(applied.seam).toBe('ocr-provider');
    // Only 'accuracy' was requested via --traits, so 'latency' must be excluded.
    expect(applied.values).toEqual({
      apple_vision: { accuracy: 0.42 },
      llm_api: { accuracy: 0.97 },
    });
    expect(process.exitCode ?? 0).toBe(0);

    const overrides = getSeamTraitOverrides('ocr-provider');
    expect(overrides.apple_vision?.traits.accuracy).toBe(0.42);
    expect(overrides.llm_api?.traits.accuracy).toBe(0.97);
    expect(overrides.apple_vision?.traits.latency).toBeUndefined();
  });

  it('runs a calibration with a fake adapter and writes a comparison report', async () => {
    process.exitCode = undefined;
    const fakeDispose = registerSeamCalibrationAdapter({
      seam: 'ocr-provider',
      description: 'fake calibration adapter for the CLI test',
      input_example: {},
      async listCandidates() {
        return [
          { id: 'apple_vision', eligible: true },
          { id: 'llm_api', eligible: true },
        ];
      },
      async runTrial(providerId: string) {
        return {
          ok: true,
          output: { text: `hello from ${providerId}` },
          metrics: { char_error_rate: providerId === 'apple_vision' ? 0.1 : 0.05 },
        };
      },
      trait_mappings: {
        accuracy: { metric: 'char_error_rate', higher_is_better: false },
      },
    });

    try {
      const inputPath = path.join(workDir, 'calibrate-input.json');
      safeWriteFile(inputPath, JSON.stringify({ image_path: 'irrelevant.png' }), {
        encoding: 'utf8',
      });

      await runSeamSelection([
        'calibrate',
        '--seam',
        'ocr-provider',
        '--input',
        pathResolver.toRepoRelative(inputPath),
        '--repeats',
        '1',
      ]);
      const report = lastPrintedJson<{
        seam: string;
        providers: unknown[];
        suggested_traits: Record<string, unknown>;
        report_json: string;
      }>(logSpy);

      expect(report.seam).toBe('ocr-provider');
      expect(report.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider_id: 'apple_vision', success_rate: 1 }),
          expect.objectContaining({ provider_id: 'llm_api', success_rate: 1 }),
        ])
      );
      expect(report.suggested_traits.accuracy).toBeDefined();
      expect(process.exitCode ?? 0).toBe(0);

      // Clean up the run directory the calibration module wrote outside
      // active/shared/tmp/ (its own governed location), not just our input file.
      const reportJsonAbs = pathResolver.rootResolve(report.report_json);
      calibrationRunDirs.push(path.dirname(reportJsonAbs));
    } finally {
      fakeDispose();
      // Restore the real adapter for any test running after this one.
      registerSeamCalibrationAdapter(ocrProviderCalibrationAdapter);
    }
  });
});
