import { pathResolver } from '@agent/core/path-resolver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResultAsync: mocks.execute,
}));
import {
  DEFAULT_CONCURRENT_GATES,
  loadGateManifest,
  main,
  parseCheckJobs,
  selectGates,
} from './run_checks.js';

const gates = (scope: 'pr' | 'full' = 'pr') => selectGates(loadGateManifest(), scope);
type Report = {
  scope: string;
  results: Array<{ id: string; status: string; exitCode: number | null }>;
  failed: number;
  error?: string;
};
const commandKey = (command: string, args: string[]) => JSON.stringify([command, args]);
const declaredCommand = (gate: ReturnType<typeof gates>[number]) =>
  gate.script
    ? commandKey('pnpm', ['run', gate.script])
    : commandKey(gate.executable!, gate.args || []);

describe.each([undefined, 'true'])('bounded check scheduling (GITHUB_ACTIONS=%s)', (hosted) => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('GITHUB_ACTIONS', hosted);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the default at six and accepts only canonical integers in the bounded range', () => {
    expect(DEFAULT_CONCURRENT_GATES).toBe(6);
    expect(parseCheckJobs(undefined)).toBe(6);
    for (let jobs = 1; jobs <= 6; jobs++) expect(parseCheckJobs(String(jobs))).toBe(jobs);
    for (const value of [
      '',
      '0',
      '7',
      '-1',
      '1.5',
      '01',
      ' 1',
      '1 ',
      'NaN',
      'Infinity',
      '1e0',
      '0x1',
    ]) {
      expect(() => parseCheckJobs(value)).toThrow('integer from 1 to 6');
    }
  });

  it.each([
    ['--jobs'],
    ['--jobs', '--json'],
    ['--jobs', '0'],
    ['--jobs', '7'],
    ['--jobs', '-1'],
    ['--jobs', '1.5'],
    ['--jobs', 'foo'],
    ['--jobs', '01'],
    ['--jobs', '1', '--jobs', '2'],
    ['--jobs=1'],
  ])('rejects invalid jobs before launching any gate: %j', async (...args) => {
    const output: Report[] = [];
    expect(await main([...args, '--json'], (value) => output.push(value as Report))).toBe(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ results: [], failed: 0 });
    expect(output[0].error).toMatch(/jobs/);
  });

  it.each([
    ['pr', false, 0],
    ['pr', true, null],
    ['pr', true, 1],
    ['full', false, 0],
    ['full', true, null],
    ['full', true, 1],
  ] as const)(
    'preserves all selected gates, report order and failure propagation (%s, failure=%s)',
    async (scope, fail, failureCode) => {
      const selected = gates(scope);
      if (scope === 'pr') expect(selected).toHaveLength(51);
      const expectedCommands = selected.map(declaredCommand).sort();
      const failingCommand = declaredCommand(selected[0]);
      const reports: Report[] = [];
      for (const jobs of [undefined, '1', '6']) {
        let active = 0;
        let peak = 0;
        let packageActive = 0;
        let packagePeak = 0;
        let started = 0;
        const seen: string[] = [];
        mocks.execute.mockImplementation(
          async (command: string, args: string[], options: unknown) => {
            const key = commandKey(command, args);
            const declared = selected.find((gate) => declaredCommand(gate) === key)!;
            expect(options).toEqual({
              cwd: pathResolver.rootDir(),
              timeoutMs: declared.timeout_ms ?? 120_000,
              ...(declared.id === 'mos-no-write-api' && process.env.GITHUB_ACTIONS === 'true'
                ? { env: { GITHUB_ACTIONS: 'true' } }
                : {}),
            });
            seen.push(key);
            const ordinal = started++;
            active++;
            peak = Math.max(peak, active);
            const packageGate =
              command === 'pnpm' ||
              args.some((arg) => arg.endsWith('check_chronos_dom_contrast.ts'));
            if (packageGate) packagePeak = Math.max(packagePeak, ++packageActive);
            await new Promise((resolve) => setTimeout(resolve, ordinal % 2 === 0 ? 4 : 1));
            active--;
            if (packageGate) packageActive--;
            return {
              status: fail && key === failingCommand ? failureCode : 0,
              stdout: '',
              stderr: fail && key === failingCommand ? 'fixture failure' : '',
            };
          }
        );
        const output: Report[] = [];
        const args = ['--scope', scope, '--json', ...(jobs === undefined ? [] : ['--jobs', jobs])];
        expect(await main(args, (value) => output.push(value as Report))).toBe(fail ? 1 : 0);
        expect(seen.sort()).toEqual(expectedCommands);
        expect(started).toBe(selected.length);
        expect(peak).toBe(jobs === '1' ? 1 : 6);
        expect(packagePeak).toBe(scope === 'pr' ? 0 : 1);
        expect(active).toBe(0);
        expect(packageActive).toBe(0);
        expect(output).toHaveLength(1);
        expect(output[0].results.map((result) => result.id)).toEqual(
          selected.map((gate) => gate.id)
        );
        expect(output[0].results).toHaveLength(selected.length);
        expect(output[0].failed).toBe(fail ? 1 : 0);
        reports.push(output[0]);
      }
      expect(reports[1]).toEqual(reports[0]);
      expect(reports[2]).toEqual(reports[0]);
    }
  );

  it('releases the package-manager lane after a failed package gate', async () => {
    let packageCalls = 0;
    mocks.execute.mockImplementation(async (command: string) => ({
      status: command === 'pnpm' && packageCalls++ === 0 ? 1 : 0,
      stdout: '',
      stderr: '',
    }));
    const output: Report[] = [];
    expect(
      await main(['--scope', 'full', '--jobs', '1', '--json'], (value) =>
        output.push(value as Report)
      )
    ).toBe(1);
    expect(packageCalls).toBe(
      gates('full').filter((gate) => gate.script || gate.executable === 'pnpm').length
    );
    expect(output[0].results).toHaveLength(gates('full').length);
    expect(output[0].failed).toBe(1);
    mocks.execute.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    expect(await main(['--scope', 'full', '--jobs', '1'])).toBe(0);
  });
});
