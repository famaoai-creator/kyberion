import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  obtainBestOfProvidersJudgeVerdict,
  parseBestOfJudgeVerdict,
} from './mission-orchestration-worker-part-results.js';
import { runBestOfProviders, type BestOfProviderBackend } from '../best-of-providers.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';

describe('parseBestOfJudgeVerdict', () => {
  it('normalizes a JSON verdict embedded in model text', () => {
    expect(
      parseBestOfJudgeVerdict(
        'Result:\n{"winner":"b","rationale":"robust","merge_hints":["keep tests"]}'
      )
    ).toEqual({
      winner: 'B',
      rationale: 'robust',
      merge_hints: ['keep tests'],
    });
  });

  it('rejects a non-object response and preserves the caller fallback', () => {
    expect(parseBestOfJudgeVerdict('[{"winner":"A"}]')).toBeNull();
    expect(parseBestOfJudgeVerdict('{"winner":{"value":"A"}}')).toBeNull();
  });

  it('drops non-string merge hints instead of stringifying arbitrary values', () => {
    expect(
      parseBestOfJudgeVerdict('{"winner":"A","merge_hints":["valid",{"secret":"x"},3]}')
    ).toEqual({
      winner: 'A',
      merge_hints: ['valid'],
    });
  });

  it('rejects nested dangerous JSON keys', () => {
    expect(parseBestOfJudgeVerdict('{"winner":"A","meta":{"__proto__":{}}}')).toBeNull();
  });
});

describe('obtainBestOfProvidersJudgeVerdict (XP-07 wiring)', () => {
  const VERDICT_LOG_DIR = pathResolver.sharedTmp(`mo07-best-of-providers-${process.pid}`);
  const VERDICT_LOG_PATH = path.join(VERDICT_LOG_DIR, 'verdicts.jsonl');

  afterEach(() => {
    safeRmSync(VERDICT_LOG_DIR, { recursive: true, force: true });
  });

  function judgeBackend(output: string): BestOfProviderBackend {
    return {
      async delegateTask() {
        return output;
      },
    };
  }

  it('fans the judge prompt out across providers and takes the plurality verdict', async () => {
    const backends: Record<string, BestOfProviderBackend> = {
      claude: judgeBackend('{"winner":"B","rationale":"robust edge cases"}'),
      codex: judgeBackend('{"winner":"B","rationale":"robust edge cases covered"}'),
      agy: judgeBackend('{"winner":"A","rationale":"smallest change wins here today"}'),
    };
    const seen: Array<{ dataTier: string; instruction: string }> = [];
    const outcome = await obtainBestOfProvidersJudgeVerdict({
      judgePrompt: 'Pick A or B',
      taskId: 'T1',
      securityScope: {
        mission_id: 'MSN-1',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'test',
      },
      run: (options) => {
        seen.push({ dataTier: options.dataTier, instruction: options.instruction });
        return runBestOfProviders({
          ...options,
          providers: ['claude', 'codex', 'agy'],
          seams: {
            getBackend: (provider) => backends[provider] ?? null,
            verdictLogPath: VERDICT_LOG_PATH,
          },
        });
      },
    });

    expect(seen).toEqual([{ dataTier: 'public', instruction: 'Pick A or B' }]);
    expect(outcome?.verdict?.winner).toBe('B');
    expect(outcome?.participants.sort()).toEqual(['agy', 'claude', 'codex']);
  });

  it('treats an unscoped judge prompt as confidential and never fans out when egress is denied', async () => {
    const tiers: string[] = [];
    const run = vi.fn(async (options: { dataTier: string }) => {
      tiers.push(options.dataTier);
      throw new Error('no providers');
    });
    expect(
      await obtainBestOfProvidersJudgeVerdict({ judgePrompt: 'x', taskId: 'T2', run: run as any })
    ).toBeNull();
    expect(tiers).toEqual(['confidential']);

    run.mockClear();
    expect(
      await obtainBestOfProvidersJudgeVerdict({
        judgePrompt: 'x',
        taskId: 'T3',
        securityScope: {
          mission_id: 'MSN-1',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'test',
          external_egress: 'deny',
        },
        run: run as any,
      })
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('returns a null verdict when no provider produced output, so the single-agent judge runs', async () => {
    const outcome = await obtainBestOfProvidersJudgeVerdict({
      judgePrompt: 'Pick A or B',
      taskId: 'T4',
      securityScope: {
        mission_id: 'MSN-1',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'test',
      },
      run: (options) =>
        runBestOfProviders({
          ...options,
          providers: ['claude'],
          seams: { getBackend: () => null, verdictLogPath: VERDICT_LOG_PATH },
        }),
    });
    expect(outcome?.verdict).toBeNull();
  });
});
