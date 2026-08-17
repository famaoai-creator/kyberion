import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { loadEvalHarnessTable, runEvalHarnessTable } from './eval_harness.js';

const RUN_PATH = `active/shared/tmp/pi18-eval-${process.pid}.jsonl`;

afterEach(() => {
  const path = pathResolver.rootResolve(RUN_PATH);
  if (safeExistsSync(path)) safeRmSync(path);
});

describe('PI-18 named eval harness table', () => {
  it('loads the checked-in A/B table and preserves named configurations', () => {
    expect(loadEvalHarnessTable().map((entry) => entry.name)).toEqual(['baseline', 'policy-aware']);
  });

  it('runs the same brief across configurations and reloads facets in one session', async () => {
    const seen: Array<{ configuration: string; reloadCount: number }> = [];
    const result = await runEvalHarnessTable({
      table: loadEvalHarnessTable(),
      brief: 'compare the governed output',
      sessionId: 'session-pi18-test',
      runPath: RUN_PATH,
      steps: [
        { type: 'prompt', prompt: 'compare the governed output' },
        { type: 'reload' },
        { type: 'prompt', prompt: 'compare the governed output' },
      ],
      executor: (prompt, context) => {
        seen.push({ configuration: context.configuration.name, reloadCount: context.reloadCount });
        return `${context.configuration.name}:${context.reloadCount}:${prompt}`;
      },
    });

    expect(result.schema_version).toBe('pi-eval-harness.v1');
    expect(result.session_id).toBe('session-pi18-test');
    expect(result.step_types).toEqual(['prompt', 'reload', 'prompt']);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((entry) => entry.prompt_receipts)).toHaveLength(2);
    expect(result.results[0]?.prompt_receipts[1]?.reload_count).toBe(1);
    expect(result.results[1]?.prompt_receipts[1]?.reload_count).toBe(1);
    expect(seen).toEqual([
      { configuration: 'baseline', reloadCount: 0 },
      { configuration: 'baseline', reloadCount: 1 },
      { configuration: 'policy-aware', reloadCount: 0 },
      { configuration: 'policy-aware', reloadCount: 1 },
    ]);
    expect(safeExistsSync(pathResolver.rootResolve(RUN_PATH))).toBe(true);
  });
});
