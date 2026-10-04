import { afterEach, describe, expect, it } from 'vitest';

import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_INBOX_PATH,
  DOT_WAKE_RETRY_AFTER_MS,
  dotDailyTokenCapReached,
  dotTokensUsedToday,
  dotWakeSummary,
  DOT_WAKE_SUMMARY_MAX,
  evaluateDotTriggersDue,
  listActiveDotHeartbeatIds,
  readDotWakeLedger,
  recordDotTokenUsage,
  recordDotWatchSnapshot,
  runDotWake,
  type DotWakeLoopResult,
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

function fakeResult(turns: number, tokens: number): DotWakeLoopResult {
  return {
    finalState: 'completed',
    goal: { budgetStats: { tokensUsed: tokens } },
    turnsRun: turns,
  };
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
        hasRole: () => true,
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
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(receipt.outcome).toBe('skipped');
    expect(receipt.reason).toContain('paused');
  });

  it('enforces token_cap_per_day across wakes', async () => {
    writeCharter(CHARTER);
    const deps = {
      rootDir: TEST_ROOT,
      runLoop: async () => fakeResult(1, 600),
      hasRole: () => true,
    };
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
      hasRole: () => true,
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
      hasRole: () => true,
    });
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.reason).toBe('delegated-turn');
    expect(delegatedPrompt).toContain('repo-guardian');
    expect(delegatedPrompt).toContain('Keep CI green.');
    const ledger = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(ledger[0].turns_run).toBe(1);
    expect(dotTokensUsedToday('repo-guardian', { rootDir: TEST_ROOT })).toBeGreaterThan(0);
  });

  it('governs proposals from a delegated reply instead of letting the child act', async () => {
    writeCharter(CHARTER);
    const governed: Array<{ dot: string; titles: string[] }> = [];
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    let delegatedPrompt = '';
    const receipt = await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      backend: {
        delegateTask: async (instruction: string) => {
          delegatedPrompt = instruction;
          return [
            'CI is red on main.',
            '```dot-proposals',
            '[{"title":"Fix main","objective":"Repair the failing test.","work_shape":"task_session"}]',
            '```',
          ].join('\n');
        },
      },
      hasRole: () => true,
      dispatch: (charter, proposals) => {
        governed.push({ dot: charter.dot_id, titles: proposals.map((p) => p.title) });
        return [];
      },
    });
    expect(delegatedPrompt).toContain('```dot-proposals');
    expect(receipt.outcome).toBe('delivered');
    expect(governed).toEqual([{ dot: 'repo-guardian', titles: ['Fix main'] }]);
  });

  it('collects dot_propose_action tool calls from the goal loop and refuses other tools', async () => {
    writeCharter(CHARTER);
    const governed: string[] = [];
    const toolReplies: string[] = [];
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    const receipt = await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      runLoop: async (options) => {
        expect(options.extraTools?.map((t) => t.name)).toEqual(['dot_propose_action']);
        expect(options.toolRole).toBe('infrastructure_sentinel');
        toolReplies.push(
          options.executeTool!({
            name: 'dot_propose_action',
            input: {
              title: 'Rerun CI',
              objective: 'Re-run the flaky job.',
              work_shape: 'task_session',
            },
          }).resultText,
          options.executeTool!({ name: 'shell_exec', input: { cmd: 'rm -rf /' } }).resultText,
          options.executeTool!({
            name: 'dot_propose_action',
            input: { title: 'Bad', objective: 'x', work_shape: 'deploy' },
          }).resultText
        );
        return fakeResult(1, 10);
      },
      dispatch: (_charter, proposals) => {
        governed.push(...proposals.map((p) => p.title));
        return [];
      },
    });
    expect(governed).toEqual(['Rerun CI']);
    expect(toolReplies[1]).toMatch(/not available to a dot/);
    expect(receipt.proposal_errors?.[0]).toMatch(/work_shape/);
  });

  it('retries a failed wake only after the backoff window', async () => {
    // Watch keys (unlike cron minute-keys) stay evaluable, so a failed watch
    // wake is the honest retry candidate.
    const watchCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'watch', paths: ['watched.txt'] }] },
    } as DotCharter;
    writeCharter(watchCharter, 'watch.json');
    safeWriteFile(`${TEST_ROOT}/watched.txt`, 'x\n');
    const dueAt = new Date('2026-10-02T10:15:00Z');
    const deps = { rootDir: TEST_ROOT, now: () => dueAt };
    const due = evaluateDotTriggersDue(watchCharter, deps);
    expect(due).toHaveLength(1);
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/watch.json`, charter: watchCharter },
      {
        ...deps,
        trigger: due[0],
        runLoop: async () => {
          throw new Error('backend down');
        },
        hasRole: () => true,
      }
    );
    expect(receipt.outcome).toBe('failed');
    // Inside the backoff window the failed row suppresses re-delivery…
    expect(evaluateDotTriggersDue(watchCharter, deps)).toHaveLength(0);
    // …and after it the same key is due again.
    const afterBackoff = new Date(dueAt.getTime() + DOT_WAKE_RETRY_AFTER_MS + 1000);
    expect(
      evaluateDotTriggersDue(watchCharter, {
        rootDir: TEST_ROOT,
        now: () => afterBackoff,
      })
    ).toHaveLength(1);
  });

  it('does not let a skipped wake consume the trigger key', async () => {
    // Capped dot: skipped leaves the key due so the event fires after reset.
    writeCharter(CHARTER);
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    const trigger = {
      trigger: CHARTER.attention.triggers[0],
      key: 'cron:x@m',
    };
    const deps = {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      runLoop: async () => fakeResult(1, 1500),
      trigger,
    };
    await runDotWake(loaded, deps); // 1500 > cap 1000 → capped
    const capped = await runDotWake(loaded, deps);
    expect(capped.outcome).toBe('skipped');
    expect(capped.reason).toContain('token_cap_per_day');
    // The skipped audit row is written once per key — retries don't flood.
    const cappedAgain = await runDotWake(loaded, deps);
    const skippedRows = readDotWakeLedger({ rootDir: TEST_ROOT }).filter(
      (r) => r.outcome === 'skipped' && r.trigger_key === trigger.key
    );
    expect(skippedRows).toHaveLength(1);
    expect(cappedAgain.outcome).toBe('skipped');
  });

  it('never runs two wakes concurrently for the same dot', async () => {
    writeCharter(CHARTER);
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = runDotWake(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      runLoop: async () => {
        await gate;
        return fakeResult(1, 5);
      },
    });
    const second = await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      runLoop: async () => fakeResult(1, 5),
    });
    expect(second.outcome).toBe('skipped');
    expect(second.reason).toContain('in progress');
    release();
    expect((await slow).outcome).toBe('delivered');
  });

  it('does not dedupe across dots (shared cron expr / broadcast inbox)', async () => {
    const other = {
      ...CHARTER,
      dot_id: 'second-dot',
      runtime: { heartbeat_id: 'dot-second' },
    } as DotCharter;
    writeCharter(CHARTER, 'a.json');
    writeCharter(other, 'b.json');
    const dueAt = new Date('2026-10-02T10:15:00Z');
    // Both dots are due for the same cron minute.
    expect(evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt })).toHaveLength(
      1
    );
    expect(evaluateDotTriggersDue(other, { rootDir: TEST_ROOT, now: () => dueAt })).toHaveLength(1);
    // Delivering one must not consume the other's key.
    const deps = {
      rootDir: TEST_ROOT,
      now: () => dueAt,
      hasRole: () => true,
      runLoop: async () => fakeResult(1, 5),
    };
    const dueA = evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => dueAt });
    await runDotWake(
      { path: `${TEST_ROOT}/dots/a.json`, charter: CHARTER },
      {
        ...deps,
        trigger: dueA[0],
      }
    );
    expect(evaluateDotTriggersDue(other, { rootDir: TEST_ROOT, now: () => dueAt })).toHaveLength(1);
  });

  it('records a wake outcome row for a delegated turn under the wall clock', async () => {
    // delegated fallback path already covered above; this asserts the wake
    // prompt carries the trigger detail so the agent sees why it woke.
    writeCharter(CHARTER);
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER };
    let prompt = '';
    const trigger = {
      trigger: CHARTER.attention.triggers[0],
      key: 'cron:x@m',
      detail: 'cron detail',
    };
    await runDotWake(loaded, {
      rootDir: TEST_ROOT,
      hasRole: () => true,
      backend: {
        delegateTask: async (instruction: string) => {
          prompt = instruction;
          return 'ok';
        },
      },
      trigger,
    });
    expect(prompt).toContain('cron:x@m');
    expect(prompt).toContain('cron detail');
  });

  it('keeps a reply summary for system charters only, never tenant prose', async () => {
    const reply = 'Nothing to propose today.\n```dot-proposals\n[]\n```';
    const backend = { delegateTask: async () => reply };
    writeCharter(CHARTER);
    await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      { rootDir: TEST_ROOT, hasRole: () => true, backend }
    );
    const tenant: DotCharter = {
      ...CHARTER,
      dot_id: 'tenant-dot',
      scope: { ...CHARTER.scope, tenant_slug: 'acme' },
      runtime: { heartbeat_id: 'dot-tenant-dot' },
    };
    writeCharter(tenant, 'tenant.json');
    await runDotWake(
      { path: `${TEST_ROOT}/dots/tenant.json`, charter: tenant },
      { rootDir: TEST_ROOT, hasRole: () => true, backend }
    );
    const rows = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(rows.find((row) => row.dot_id === CHARTER.dot_id)?.summary).toBe(
      'Nothing to propose today.'
    );
    const tenantRow = rows.find((row) => row.dot_id === 'tenant-dot');
    expect(tenantRow?.outcome).toBe('delivered');
    expect(tenantRow?.summary).toBeUndefined();
  });
});

describe('dotWakeSummary', () => {
  it('keeps the prose, drops the proposal block, and bounds the length', () => {
    const text =
      'All signals green.\n\nNothing to propose: the operator rejected the last two.\n```dot-proposals\n[]\n```';
    expect(dotWakeSummary(text)).toBe(
      'All signals green. Nothing to propose: the operator rejected the last two.'
    );
    expect(dotWakeSummary('```dot-proposals\n[]\n```')).toBeUndefined();
    expect(dotWakeSummary('x'.repeat(5000))).toHaveLength(DOT_WAKE_SUMMARY_MAX);
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
