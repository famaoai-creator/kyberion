import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import { evaluateDotProbeTriggers, runDotWake, type DotWakeLoopResult } from './dot-runtime.js';

const TEST_ROOT = 'active/shared/tmp/dot-runtime-probe-tests';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'probe-dot',
  version: '1.0.0',
  title: 'Probe dot',
  purpose: 'Watch external state.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'React to external state changes.' },
  attention: {
    triggers: [
      {
        kind: 'probe',
        probe: { type: 'file', path: 'probe-target.txt', expect: 'exists' },
      },
    ],
  },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-probe-dot' },
};

function writeCharter(charter: unknown, name = 'dot.json'): void {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  safeWriteFile(`${TEST_ROOT}/dots/${name}`, JSON.stringify(charter, null, 2) + '\n');
}

function fakeResult(): DotWakeLoopResult {
  return { finalState: 'completed', goal: { budgetStats: { tokensUsed: 1 } }, turnsRun: 1 };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('evaluateDotProbeTriggers', () => {
  it('does not fire while the file is absent, fires when it appears, then dedups', async () => {
    writeCharter(CHARTER);
    // File probe path is repo-relative under rootDir.
    expect(await evaluateDotProbeTriggers(CHARTER, { rootDir: TEST_ROOT })).toHaveLength(0);

    safeWriteFile(`${TEST_ROOT}/probe-target.txt`, 'present');
    const due = await evaluateDotProbeTriggers(CHARTER, { rootDir: TEST_ROOT });
    expect(due).toHaveLength(1);
    expect(due[0].key).toMatch(/^probe:[0-9a-f]{16}:[0-9a-f]{24}$/);

    // Deliver the wake — the key is consumed and does not re-fire.
    await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        runLoop: async () => fakeResult(),
        trigger: due[0],
        hasRole: () => true,
      }
    );
    expect(await evaluateDotProbeTriggers(CHARTER, { rootDir: TEST_ROOT })).toHaveLength(0);
  });

  it('changed expectation establishes a baseline, then fires once per new fingerprint', async () => {
    const charter: DotCharter = {
      ...CHARTER,
      attention: {
        triggers: [
          {
            kind: 'probe',
            probe: {
              type: 'service_preset',
              service_id: 'github',
              action: 'get_pull',
              expect: { json_path: 'state', changed: true },
            },
          },
        ],
      },
    };
    writeCharter(charter);
    let state = 'open';
    const serviceCall = async () => ({ state });

    // Baseline only — activating the probe must not fire on the current state.
    expect(
      await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, serviceCall })
    ).toHaveLength(0);

    state = 'closed';
    const due = await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, serviceCall });
    expect(due).toHaveLength(1);
    // At-least-once: the same key stays due until delivered — the comparison
    // point is the last DELIVERED fingerprint, not the last evaluation.
    expect(
      await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, serviceCall })
    ).toHaveLength(1);
    await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter },
      {
        rootDir: TEST_ROOT,
        runLoop: async () => fakeResult(),
        trigger: due[0],
        hasRole: () => true,
      }
    );
    expect(
      await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, serviceCall })
    ).toHaveLength(0);

    // Oscillating back to a previously seen fingerprint re-fires: the key is
    // content-addressed per fingerprint, not consumed forever per spec.
    state = 'open';
    expect(
      await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, serviceCall })
    ).toHaveLength(1);
  });

  it('honours every_s as the minimum evaluation interval', async () => {
    const charter: DotCharter = {
      ...CHARTER,
      attention: {
        triggers: [
          {
            kind: 'probe',
            every_s: 300,
            probe: {
              type: 'service_preset',
              service_id: 's',
              action: 'a',
              expect: { changed: true },
            },
          },
        ],
      },
    };
    writeCharter(charter);
    let calls = 0;
    const serviceCall = async () => {
      calls += 1;
      return { v: calls };
    };
    const t0 = new Date('2026-10-03T00:00:00Z');
    await evaluateDotProbeTriggers(charter, { rootDir: TEST_ROOT, now: () => t0, serviceCall });
    expect(calls).toBe(1);
    await evaluateDotProbeTriggers(charter, {
      rootDir: TEST_ROOT,
      now: () => new Date(t0.getTime() + 60_000),
      serviceCall,
    });
    expect(calls).toBe(1); // inside every_s — skipped before calling
    await evaluateDotProbeTriggers(charter, {
      rootDir: TEST_ROOT,
      now: () => new Date(t0.getTime() + 301_000),
      serviceCall,
    });
    expect(calls).toBe(2);
  });
});
