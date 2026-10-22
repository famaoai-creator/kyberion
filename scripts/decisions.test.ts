import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { ScriptExitError } from '@agent/core/script-harness';
import {
  parseBasis,
  parseDecisionsArgs,
  runDecisions,
  type DecisionImportSummary,
} from './decisions.js';

describe('decisions facade', () => {
  let dir: string;
  beforeEach(() => {
    dir = pathResolver.sharedTmp(`decisions-facade-test-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('parses verbs, options and bare flags', () => {
    expect(parseDecisionsArgs(['ask', '--tenant', 't', '--case', 'c', '--dry-run'])).toEqual({
      verb: 'ask',
      opts: { tenant: 't', case: 'c' },
      flags: new Set(['dry-run']),
    });
    expect(parseBasis('QA-1@r1,DEC-2,X@')).toEqual([
      { ref: 'QA-1', version: 'r1' },
      { ref: 'DEC-2', version: 'unversioned' },
      { ref: 'X', version: 'unversioned' },
    ]);
  });

  it('requires a tenant and case unless a test directory is given', async () => {
    await expect(runDecisions(['list'])).rejects.toBeInstanceOf(ScriptExitError);
    expect(await runDecisions(['list', '--dir', dir])).toEqual([]);
  });

  it('proposes, asks, decides and imports through one ledger', async () => {
    const proposed = (await runDecisions([
      'propose',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--item',
      'SCR-1#B35',
      '--key',
      'csv.columns',
      '--level',
      'product-fixed',
    ])) as { appended: Array<{ id: string }> };
    expect(proposed.appended[0].id).toBe('D-0001');

    const ask = (await runDecisions(['ask', '--dir', dir, '--case', 'case-a'])) as Array<{
      id: string;
      ask: string;
    }>;
    expect(ask).toEqual([
      expect.objectContaining({ id: 'D-0001', ask: 'product', state: 'proposed' }),
    ]);

    const pending = `${dir}/pending.jsonl`;
    safeWriteFile(
      pending,
      [
        JSON.stringify({
          promote: 'D-0001',
          value: ['a', 'b', 'c'],
          decided_by: { kind: 'human', id: 'user:alice', role: 'owner' },
          basis: [{ ref: 'hearing:s1', version: 'turn:t1' }],
          origin: 'hearing',
        }),
        JSON.stringify({
          append: {
            item: 'SCR-2#B5',
            key: 'balance.kind',
            level: 'customer-value',
            state: 'proposed',
            value: null,
            basis: [],
            origin: 'observation',
          },
        }),
        JSON.stringify({
          concept: {
            id: 'PC-s1',
            title: 'deal tracker',
            status: 'draft',
            for_whom: [{ actor: 'sales', context: 'weekly review' }],
            promises: [{ statement: 'stage updated weekly', measured_by: 'stage age <= 7d' }],
            source: { kind: 'hearing', session_id: 's1', scenario: 'web_app_build' },
            recorded_by: { kind: 'human', id: 'user:alice' },
            recorded_at: '2026-09-14T00:00:00.000Z',
          },
        }),
      ].join('\n') + '\n',
      { encoding: 'utf8' }
    );
    const dry = (await runDecisions([
      'import',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--file',
      pending,
      '--dry-run',
    ])) as DecisionImportSummary;
    expect(dry.dry_run).toBe(true);
    expect(await runDecisions(['list', '--dir', dir])).toHaveLength(1);

    const summary = (await runDecisions([
      'import',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--file',
      pending,
    ])) as DecisionImportSummary;
    expect(summary.promoted).toEqual([{ promote: 'D-0001', outcome: 'decided', id: 'D-0003' }]);
    expect(summary.appended).toEqual(['D-0002']);
    expect(summary.concepts).toEqual(['PC-s1']);
    expect(summary.superseded).toEqual(['D-0001']);

    const remaining = (await runDecisions(['ask', '--dir', dir, '--case', 'case-a'])) as Array<{
      id: string;
      ask: string;
    }>;
    expect(remaining.map((item) => [item.id, item.ask])).toEqual([['D-0002', 'customer']]);
  });

  it('seeds and decides in one step, and refuses a viewer', async () => {
    const decided = (await runDecisions([
      'decide',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--item',
      'SCR-1#B27',
      '--key',
      'memo.max_length',
      '--level',
      'product-fixed',
      '--value',
      '{"max":30,"unit":"byte"}',
      '--by',
      'user:alice',
      '--role',
      'owner',
      '--basis',
      'V-201@r1',
    ])) as { results: Array<{ result: { outcome: string } }> };
    expect(decided.results[0].result.outcome).toBe('decided');

    const refused = (await runDecisions([
      'decide',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--item',
      'SCR-1#B9',
      '--key',
      'period.options',
      '--level',
      'product-fixed',
      '--value',
      '4',
      '--by',
      'user:vic',
      '--role',
      'viewer',
      '--basis',
      'BR-5@r1',
    ])) as { results: Array<{ result: { outcome: string; reason?: string } }> };
    expect(refused.results[0].result).toMatchObject({
      outcome: 'proposed',
      reason: 'role_cannot_decide',
    });
  });

  it('check writes report and lock, and exits 1 when the implementation disagrees', async () => {
    await runDecisions([
      'decide',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--item',
      'SCR-1#B35',
      '--key',
      'csv.columns',
      '--level',
      'product-fixed',
      '--value',
      '["a","b"]',
      '--by',
      'user:alice',
      '--basis',
      'QA-1@r1',
    ]);
    const observed = `${dir}/observed.input.json`;
    safeWriteFile(
      observed,
      JSON.stringify({
        case_id: 'case-a',
        impl: { repo: 'impl', commit: 'abc' },
        observed_at: '2026-09-14T00:00:00.000Z',
        observations: [{ key: 'csv.columns', value: ['a', 'b', 'c'], ref: 'csv.ts:1' }],
      }),
      { encoding: 'utf8' }
    );
    let thrown: unknown;
    try {
      await runDecisions(['check', '--dir', dir, '--case', 'case-a', '--observed', observed]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScriptExitError);
    expect((thrown as ScriptExitError).code).toBe(1);
    expect((thrown as ScriptExitError).returnValue).toMatchObject({
      status: 'red',
      tally: { conflict: 1 },
    });

    safeWriteFile(
      observed,
      JSON.stringify({
        case_id: 'case-a',
        impl: { repo: 'impl', commit: 'def' },
        observed_at: '2026-09-14T00:00:00.000Z',
        observations: [{ key: 'csv.columns', value: ['a', 'b'], ref: 'csv.ts:1' }],
      }),
      { encoding: 'utf8' }
    );
    const green = (await runDecisions([
      'check',
      '--dir',
      dir,
      '--case',
      'case-a',
      '--observed',
      observed,
    ])) as {
      status: string;
    };
    expect(green.status).toBe('green');
  });
});

describe('decisions probe (SD-06)', () => {
  it('runs declarative probes against a checkout inside the repository and stores the observation set', async () => {
    const dir = pathResolver.sharedTmp(`decisions-probe-test-${randomUUID()}`);
    const impl = `${dir}/impl`;
    safeMkdir(`${impl}/src`, { recursive: true });
    try {
      safeWriteFile(`${impl}/src/csv.ts`, 'const CSV_HEADER = ["a", "b", "c"];\n', {
        encoding: 'utf8',
      });
      safeWriteFile(
        `${dir}/probes.json`,
        JSON.stringify({
          version: '1.0.0',
          case_id: 'case-a',
          repo: 'impl',
          probes: [
            {
              key: 'csv.columns',
              file: 'src/csv.ts',
              pattern: 'CSV_HEADER\\s*=\\s*(\\[[^\\]]*\\])',
              capture: 'list',
            },
            { key: 'memo.max', file: 'src/memo.ts', pattern: 'x' },
          ],
        }),
        { encoding: 'utf8' }
      );
      await runDecisions([
        'decide',
        '--dir',
        dir,
        '--case',
        'case-a',
        '--item',
        'SCR-1#B35',
        '--key',
        'csv.columns',
        '--level',
        'product-fixed',
        '--value',
        '["a","b"]',
        '--by',
        'user:alice',
        '--basis',
        'QA-1@r1',
      ]);
      const probed = (await runDecisions([
        'probe',
        '--dir',
        dir,
        '--case',
        'case-a',
        '--impl',
        impl,
        '--probes',
        `${dir}/probes.json`,
        '--commit',
        'abc',
      ])) as {
        observed: number;
        misses: Array<{ key: string; reason: string }>;
        impl: { commit: string };
      };
      expect(probed.observed).toBe(1);
      expect(probed.misses).toEqual([
        { key: 'memo.max', reason: 'file_missing', file: 'src/memo.ts' },
      ]);
      expect(probed.impl.commit).toBe('abc');
      let thrown: unknown;
      try {
        await runDecisions(['check', '--dir', dir, '--case', 'case-a']);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as ScriptExitError).returnValue).toMatchObject({
        status: 'red',
        impl: { commit: 'abc' },
        tally: { conflict: 1 },
      });
    } finally {
      safeRmSync(dir, { recursive: true, force: true });
    }
  });
});
