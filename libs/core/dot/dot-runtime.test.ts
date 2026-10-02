import { afterEach, describe, expect, it } from 'vitest';

import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { GoalDrivenLoopResult } from '../workforce/worker-goal-driver.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_INBOX_PATH,
  dotDailyTokenCapReached,
  dotTokensUsedToday,
  evaluateDotTriggersDue,
  listActiveDotHeartbeatIds,
  readDotWakeLedger,
  recordDotTokenUsage,
  recordDotWatchSnapshot,
  runDotWake,
} from './dot-runtime.js';

const TEST_ROOT = 'active/shared/tmp/dot-runtime-tests';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy.',
  status: 'active',
  scope: { tier: 'public' },
  goal: {
    statement: 'Keep CI green.',
    budget: { max_turns_per_wake: 2, wall_clock_ms_per_wake: 60_000, token_cap_per_day: 1000 },
  },
  attention: {
    triggers: [{ kind: 'cron', cron: '*/15 * * * *', timezone: 'UTC' }],
  },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

function writeCharter(charter: unknown, name = 'dot.json'): void {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  safeWriteFile(`${TEST_ROOT}/dots/${name}`, JSON.stringify(charter, null, 2) + '\n');
}

function fakeResult(turns: number, tokens: number): GoalDrivenLoopResult {
  return {
    goalId: 'g',
    finalState: 'completed',
    goal: { budgetStats: { tokensUsed: tokens, turnsUsed: turns, wallClockMsUsed: 0 } },
    turnsRun: turns,
    rewindCount: 0,
    persisted: null,
  } as unknown as GoalDrivenLoopResult;
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('evaluateDotTriggersDue', () => {
  it('fires a cron trigger on a matching minute and dedups via the ledger', async () => {
    writeCharter(CHARTER);
    const dueAt = new Date('2026-10-02T10:15:30Z');
    const due = evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt });
    expect(due).toHaveLength(1);
    expect(due[0].key).toBe('cron:*/15 * * * *@2026-10-02T10:15');

    // Deliver it, then re-evaluate the same minute: not due again.
    await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        now: () => dueAt,
        runLoop: async () => fakeResult(1, 10),
        trigger: due[0],
      }
    );
    expect(evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt })).toHaveLength(
      0
    );
    // Next matching minute produces a new key.
    const later = new Date('2026-10-02T10:30:00Z');
    expect(evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => later })).toHaveLength(
      1
    );
  });

  it('does not fire on a non-matching minute', () => {
    const notDue = new Date('2026-10-02T10:16:00Z');
    expect(evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => notDue })).toHaveLength(
      0
    );
  });

  it('respects the charter timezone for cron evaluation', () => {
    // 19:15 UTC is 04:15 JST — matches */15 either way; use 10:14 UTC = 19:14 JST.
    const jstCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'cron', cron: '0 4 * * *', timezone: 'Asia/Tokyo' }] },
    } as DotCharter;
    const jstMidnight = new Date('2026-10-01T19:00:00Z'); // 04:00 JST Oct 2
    expect(
      evaluateDotTriggersDue(jstCharter, { rootDir: TEST_ROOT, now: () => jstMidnight })
    ).toHaveLength(1);
  });

  it('fires a watch trigger when a watched path changes', async () => {
    const watchCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'watch', paths: ['watched.txt'] }] },
    } as DotCharter;
    writeCharter(watchCharter);
    safeWriteFile(`${TEST_ROOT}/watched.txt`, 'v1\n');
    // No snapshot yet → due; snapshot it (as a delivered wake would) → not due.
    const first = evaluateDotTriggersDue(watchCharter, { rootDir: TEST_ROOT });
    expect(first).toHaveLength(1);
    recordDotWatchSnapshot(watchCharter, { rootDir: TEST_ROOT });
    expect(evaluateDotTriggersDue(watchCharter, { rootDir: TEST_ROOT })).toHaveLength(0);
    // A write bumps mtime/size → due again with a new key.
    safeWriteFile(`${TEST_ROOT}/watched.txt`, 'v1\nv2 longer\n');
    expect(evaluateDotTriggersDue(watchCharter, { rootDir: TEST_ROOT })).toHaveLength(1);
  });

  it('fires a wake trigger for inbox rows on declared channels or addressed to the dot', () => {
    const wakeCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'wake', channels: ['slack'] }] },
    } as DotCharter;
    safeMkdir(`${TEST_ROOT}/active/shared/runtime`, { recursive: true });
    safeWriteFile(
      `${TEST_ROOT}/${DOT_INBOX_PATH}`,
      [
        JSON.stringify({ channel: 'slack', text: 'ping' }),
        JSON.stringify({ channel: 'telegram', text: 'other channel' }),
        JSON.stringify({ dot_id: 'repo-guardian', text: 'direct' }),
        JSON.stringify({ dot_id: 'other-dot', text: 'not ours' }),
      ].join('\n') + '\n'
    );
    const due = evaluateDotTriggersDue(wakeCharter, { rootDir: TEST_ROOT });
    expect(due.map((d) => d.key)).toHaveLength(2); // slack channel hit + direct address
    expect(due.every((d) => d.key.startsWith('wake:'))).toBe(true);
  });
});

describe('runDotWake', () => {
  it('skips when the charter is no longer active (status race)', async () => {
    writeCharter({ ...CHARTER, status: 'paused' });
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: { ...CHARTER, status: 'active' } },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5) }
    );
    expect(receipt.outcome).toBe('skipped');
    expect(receipt.reason).toContain('paused');
  });

  it('enforces token_cap_per_day across wakes', async () => {
    writeCharter(CHARTER);
    const deps = { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 600) };
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    const first = await runDotWake(loaded, deps);
    expect(first.outcome).toBe('delivered');
    expect(dotTokensUsedToday('repo-guardian', { rootDir: TEST_ROOT })).toBe(600);
    const second = await runDotWake(loaded, deps);
    expect(second.outcome).toBe('delivered');
    expect(dotTokensUsedToday('repo-guardian', { rootDir: TEST_ROOT })).toBe(1200);
    expect(dotDailyTokenCapReached(CHARTER, { rootDir: TEST_ROOT })).toBe(true);
    const third = await runDotWake(loaded, deps);
    expect(third.outcome).toBe('skipped');
    expect(third.reason).toContain('token_cap_per_day');
  });

  it('maps charter budget onto the goal loop and records the ledger', async () => {
    writeCharter(CHARTER);
    let seen: { maxTurns?: number; toolRole?: string; budget?: object } = {};
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    const receipt = await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      runLoop: async (options) => {
        seen = {
          maxTurns: options.maxTurns,
          toolRole: options.toolRole,
          budget: options.budget,
        };
        return fakeResult(2, 42);
      },
    });
    expect(receipt.outcome).toBe('delivered');
    expect(seen.maxTurns).toBe(2);
    expect(seen.toolRole).toBe('infrastructure_sentinel');
    expect(seen.budget).toEqual({ wallClockBudgetMs: 60_000, turnBudget: 2 });
    const ledger = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('delivered');
    expect(ledger[0].tokens_used).toBe(42);
    // Heartbeat landed under the test root.
    expect(
      safeExistsSync(`${TEST_ROOT}/active/shared/runtime/heartbeats/dot-repo-guardian.json`)
    ).toBe(true);
  });

  it('degrades to a single delegated turn when the backend lacks tool use', async () => {
    writeCharter(CHARTER);
    let delegatedPrompt = '';
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    const receipt = await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      backend: {
        delegateTask: async (instruction: string) => {
          delegatedPrompt = instruction;
          return 'delegated report';
        },
      },
    });
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.reason).toBe('delegated-turn');
    expect(delegatedPrompt).toContain('repo-guardian');
    expect(delegatedPrompt).toContain('Keep CI green.');
    const ledger = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(ledger[0].turns_run).toBe(1);
    expect(dotTokensUsedToday('repo-guardian', { rootDir: TEST_ROOT })).toBeGreaterThan(0);
  });

  it('keeps a failed wake retryable (failed keys are not consumed)', async () => {
    writeCharter(CHARTER);
    const dueAt = new Date('2026-10-02T10:15:00Z');
    const due = evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt });
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        now: () => dueAt,
        trigger: due[0],
        runLoop: async () => {
          throw new Error('backend down');
        },
      }
    );
    expect(receipt.outcome).toBe('failed');
    expect(evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt })).toHaveLength(
      1
    );
  });
});

describe('listActiveDotHeartbeatIds', () => {
  it('returns heartbeat ids of active charters only', () => {
    writeCharter(CHARTER, 'active.json');
    writeCharter(
      {
        ...CHARTER,
        dot_id: 'paused-dot',
        status: 'paused',
        runtime: { heartbeat_id: 'dot-paused' },
      },
      'paused.json'
    );
    expect(listActiveDotHeartbeatIds(TEST_ROOT)).toEqual(['dot-repo-guardian']);
  });
});
