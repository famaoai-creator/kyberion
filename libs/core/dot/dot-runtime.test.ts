import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUsageAttribution } from '../usage-accounting.js';
import { getFoundationIo } from '../foundation/io.js';
import * as secureIo from '../secure-io.js';
import { readJsonLines } from '../foundation/json.js';

import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_INBOX_PATH,
  DOT_WAKE_LEDGER_PATH,
  DOT_TOKEN_USAGE_PATH,
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
  applyDotWakeOutputs,
  dotWakeBackoffMs,
  evaluateDotWakeCircuit,
  normalizeDotWakeReason,
  recordDotWakeOutcome,
  DOT_WAKE_CIRCUIT_THRESHOLD,
  dotWakeErrorsPath,
  DOT_WAKE_FAILURE_CATEGORY,
  isDotWakeProcessFailure,
  type DotWakeLoopOptions,
  type DotWakeLoopResult,
} from './dot-runtime.js';
import { DOT_PROMPT_SECTIONS, DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import type { DotWakeTool } from './dot-extensions.js';
import { DOT_FOLLOWUPS_FILE, dotStatePath } from './dot-state-paths.js';
import {
  dotScheduleFollowupTool,
  evaluateDotFollowupsDue,
  listPendingDotFollowups,
} from './dot-followups.js';

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

  it('G01: token/wake ledger reads replay only new rows, never the whole history', () => {
    const now = () => new Date('2026-10-02T10:00:00Z');
    const deps = { rootDir: TEST_ROOT, now };
    // History from earlier days plus today's first row.
    for (let index = 0; index < 300; index += 1) {
      recordDotTokenUsage('repo-guardian', 5, {
        rootDir: TEST_ROOT,
        now: () => new Date(Date.UTC(2026, 8, 1 + (index % 30), 12)),
      });
    }
    recordDotTokenUsage('repo-guardian', 7, deps);
    expect(dotTokensUsedToday('repo-guardian', deps)).toBe(7);
    recordDotWakeOutcome(CHARTER, undefined, 'skipped', deps);

    const wholeFileReads = vi.spyOn(getFoundationIo(), 'readFile');
    recordDotTokenUsage('repo-guardian', 3, deps);
    expect(dotTokensUsedToday('repo-guardian', deps)).toBe(10);
    // a skipped wake's dedupe check is a ledger read on the hot path
    recordDotWakeOutcome(
      CHARTER,
      { key: 'cron:x@1', trigger: { kind: 'cron' } } as never,
      'skipped',
      deps
    );
    recordDotWakeOutcome(
      CHARTER,
      { key: 'cron:x@1', trigger: { kind: 'cron' } } as never,
      'skipped',
      deps
    );
    const ledgerReads = wholeFileReads.mock.calls.filter(
      ([file]) => file.endsWith(DOT_TOKEN_USAGE_PATH) || file.endsWith(DOT_WAKE_LEDGER_PATH)
    );
    expect(ledgerReads).toEqual([]);
    wholeFileReads.mockRestore();
    expect(readDotWakeLedger(deps).filter((row) => row.trigger_key === 'cron:x@1')).toHaveLength(1);
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
        expect(options.extraTools?.map((t) => t.name)).toEqual([
          'dot_propose_action',
          ...DOT_WAKE_TOOLS.map((t) => t.name),
        ]);
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

describe('runtime reliability (DL-02)', () => {
  afterEach(() => {
    DOT_WAKE_TOOLS.length = 0;
    DOT_PROMPT_SECTIONS.length = 0;
    vi.unstubAllEnvs();
  });

  it.each(['native', 'fenced'] as const)(
    'replaces the current follow-up at capacity one through a %s wake',
    async (mode) => {
      DOT_WAKE_TOOLS.push(dotScheduleFollowupTool);
      const charter = { ...CHARTER, followups: { max_pending: 1 } };
      writeCharter(charter);
      const scheduledAt = new Date('2026-10-04T10:00:00Z');
      const now = new Date('2026-10-04T10:06:00Z');
      dotScheduleFollowupTool.apply(charter, [{ delay_minutes: 5, reason: 'original check' }], {
        rootDir: TEST_ROOT,
        now: () => scheduledAt,
      });
      const [trigger] = evaluateDotFollowupsDue(charter, { rootDir: TEST_ROOT, now: () => now });
      const replacement = { delay_minutes: 10, reason: 'check the still-running operation again' };
      const receipt = await runDotWake(
        { path: `${TEST_ROOT}/dots/dot.json`, charter },
        {
          rootDir: TEST_ROOT,
          now: () => now,
          hasRole: () => true,
          trigger,
          ...(mode === 'native'
            ? {
                runLoop: async (options: DotWakeLoopOptions) => {
                  options.executeTool!({ name: 'dot_schedule_followup', input: replacement });
                  return fakeResult(1, 5);
                },
              }
            : {
                backend: {
                  delegateTask: async () =>
                    `\`\`\`dot-followup\n${JSON.stringify(replacement)}\n\`\`\``,
                },
              }),
        }
      );
      expect(receipt.outcome).toBe('delivered');
      expect(receipt.tool_errors).toBeUndefined();
      expect(readDotWakeLedger({ rootDir: TEST_ROOT })).toMatchObject([
        { trigger_key: trigger.key, outcome: 'delivered' },
      ]);
      expect(listPendingDotFollowups(charter, { rootDir: TEST_ROOT })).toMatchObject([
        { reason: replacement.reason, due_at: '2026-10-04T10:16:00.000Z' },
      ]);
      expect(evaluateDotFollowupsDue(charter, { rootDir: TEST_ROOT, now: () => now })).toEqual([]);
    }
  );

  it.each(['native', 'fenced'] as const)(
    'records a %s follow-up persist failure as a tool error and keeps the parent pending (backoff, no immediate retry)',
    async (mode) => {
      DOT_WAKE_TOOLS.push(dotScheduleFollowupTool);
      const charter: DotCharter = { ...CHARTER, followups: { max_pending: 1 } };
      writeCharter(charter);
      const t0 = new Date('2026-10-04T10:00:00Z');
      let now = new Date('2026-10-04T10:06:00Z');
      const deps = { rootDir: TEST_ROOT, now: () => now };
      dotScheduleFollowupTool.apply(charter, [{ delay_minutes: 5, reason: 'original' }], {
        ...deps,
        now: () => t0,
      });
      const [trigger] = evaluateDotFollowupsDue(charter, deps);
      const proposal = { title: 'Fix main', objective: 'Repair it.', work_shape: 'task_session' };
      const replacement = { delay_minutes: 10, reason: 'successor' };
      const dispatched: string[] = [];
      const originalWrite = secureIo.safeWriteFile;
      const write = vi
        .spyOn(secureIo, 'safeWriteFile')
        .mockImplementation((file, data, options) => {
          if (file.endsWith(DOT_FOLLOWUPS_FILE)) throw new Error('followup store unavailable');
          return originalWrite(file, data, options);
        });
      try {
        const receipt = await runDotWake(
          { path: `${TEST_ROOT}/dots/dot.json`, charter },
          {
            ...deps,
            trigger,
            hasRole: () => true,
            dispatch: (_charter, proposals) => {
              dispatched.push(...proposals.map((p) => p.title));
              return [];
            },
            ...(mode === 'native'
              ? {
                  runLoop: async (options: DotWakeLoopOptions) => {
                    options.executeTool!({ name: 'dot_propose_action', input: proposal });
                    options.executeTool!({ name: 'dot_schedule_followup', input: replacement });
                    return fakeResult(1, 5);
                  },
                }
              : {
                  backend: {
                    delegateTask: async () =>
                      [
                        `\`\`\`dot-proposals\n${JSON.stringify([proposal])}\n\`\`\``,
                        `\`\`\`dot-followup\n${JSON.stringify(replacement)}\n\`\`\``,
                      ].join('\n'),
                  },
                }),
          }
        );
        expect(receipt.outcome).toBe('delivered');
        expect(receipt.tool_errors).toEqual([
          'dot_schedule_followup: apply failed (followup store unavailable)',
        ]);
        expect(dispatched).toEqual(['Fix main']);
        expect(readDotWakeLedger(deps)).toMatchObject([
          { trigger_key: trigger.key, outcome: 'delivered', trigger_retained: true },
        ]);
        // The chain is not lost: the parent stays pending, but backs off — the
        // same sweep window never re-fires (nor re-dispatches) it.
        expect(listPendingDotFollowups(charter, deps).map((row) => row.reason)).toEqual([
          'original',
        ]);
        expect(evaluateDotFollowupsDue(charter, deps)).toEqual([]);
        expect(evaluateDotTriggersDue(charter, deps).some((t) => t.key === trigger.key)).toBe(
          false
        );
        write.mockRestore();
        // After the backoff the parent wakes again and its successor persists.
        now = new Date('2026-10-04T10:30:00Z');
        expect(evaluateDotFollowupsDue(charter, deps).map((t) => t.key)).toEqual([trigger.key]);
        const retry = await runDotWake(
          { path: `${TEST_ROOT}/dots/dot.json`, charter },
          {
            ...deps,
            trigger,
            hasRole: () => true,
            dispatch: () => [],
            runLoop: async (options: DotWakeLoopOptions) => {
              options.executeTool!({ name: 'dot_schedule_followup', input: replacement });
              return fakeResult(1, 5);
            },
          }
        );
        expect(retry.tool_errors).toBeUndefined();
        expect(listPendingDotFollowups(charter, deps).map((row) => row.reason)).toEqual([
          'successor',
        ]);
        expect(evaluateDotFollowupsDue(charter, deps)).toEqual([]);
      } finally {
        write.mockRestore();
      }
    }
  );

  it.each([
    ['native', 'delivery'],
    ['fenced', 'delivery'],
  ] as const)('recovers a %s follow-up when %s persistence fails', async (mode, failure) => {
    DOT_WAKE_TOOLS.push(dotScheduleFollowupTool);
    const charter: DotCharter = {
      ...CHARTER,
      followups: { max_pending: 1 },
      goal: { ...CHARTER.goal, budget: { ...CHARTER.goal.budget, token_cap_per_day: 1_000_000 } },
    };
    writeCharter(charter);
    const t0 = new Date('2026-10-04T10:00:00Z');
    let now = new Date('2026-10-04T10:06:00Z');
    const deps = { rootDir: TEST_ROOT, now: () => now };
    dotScheduleFollowupTool.apply(charter, [{ delay_minutes: 5, reason: 'original' }], {
      ...deps,
      now: () => t0,
    });
    const [trigger] = evaluateDotFollowupsDue(charter, deps);
    const followupsFile = `${TEST_ROOT}/${dotStatePath(charter, DOT_FOLLOWUPS_FILE)}`;
    const originalBytes = safeReadFile(followupsFile);
    const replacement = { delay_minutes: 10, reason: 'successor' };
    const originalWrite = secureIo.safeWriteFile;
    const io = getFoundationIo();
    const originalAppend = io.appendFile;
    const write = vi.spyOn(secureIo, 'safeWriteFile').mockImplementation((file, data, options) => {
      if (failure === 'replacement' && file.endsWith(DOT_FOLLOWUPS_FILE))
        throw new Error('followup store unavailable');
      return originalWrite(file, data, options);
    });
    const append = vi.spyOn(io, 'appendFile').mockImplementation((file, text) => {
      if (
        failure === 'delivery' &&
        file.endsWith(DOT_WAKE_LEDGER_PATH) &&
        text.includes('"outcome":"delivered"')
      ) {
        throw new Error('wake delivery ledger unavailable');
      }
      return originalAppend(file, text);
    });
    const run = () =>
      runDotWake(
        { path: `${TEST_ROOT}/dots/dot.json`, charter },
        {
          ...deps,
          trigger,
          hasRole: () => true,
          ...(mode === 'native'
            ? {
                runLoop: async (options: DotWakeLoopOptions) => {
                  options.executeTool!({ name: 'dot_schedule_followup', input: replacement });
                  return fakeResult(1, 5);
                },
              }
            : {
                backend: {
                  delegateTask: async () =>
                    `\`\`\`dot-followup\n${JSON.stringify(replacement)}\n\`\`\``,
                },
              }),
        }
      );
    try {
      expect((await run()).outcome).toBe('failed');
      expect(readDotWakeLedger(deps).some((row) => row.outcome === 'delivered')).toBe(false);
      const pending = listPendingDotFollowups(charter, deps);
      expect(pending).toHaveLength(1);
      expect(pending[0].reason).toBe(failure === 'replacement' ? 'original' : 'successor');
      if (failure === 'replacement') expect(safeReadFile(followupsFile)).toBe(originalBytes);
      now = new Date('2026-10-04T10:12:00Z');
      const due = evaluateDotFollowupsDue(charter, deps);
      expect(due.some((row) => row.key === trigger.key)).toBe(failure === 'replacement');
      write.mockRestore();
      append.mockRestore();
      // Also test a stale queued retry after successor commitment: it cannot re-arm.
      expect((await run()).outcome).toBe('delivered');
      const after = listPendingDotFollowups(charter, deps);
      expect(after).toHaveLength(1);
      expect(after[0].reason).toBe('successor');
      if (failure === 'delivery') expect(after).toEqual(pending);
    } finally {
      write.mockRestore();
      append.mockRestore();
    }
  });

  it('re-reads only its own charter file: a malformed sibling does not block the wake', async () => {
    writeCharter(CHARTER, 'dot.json');
    safeWriteFile(`${TEST_ROOT}/dots/broken.json`, '{ "kind": "dot-charter", ');
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(receipt.outcome).toBe('delivered');
  });

  it('re-reads a tenant charter from its tenant knowledge dir', async () => {
    const tenant: DotCharter = {
      ...CHARTER,
      dot_id: 'tenant-dot',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      runtime: { heartbeat_id: 'dot-tenant-dot' },
    };
    const dir = `${TEST_ROOT}/knowledge/confidential/acme/dots`;
    safeMkdir(dir, { recursive: true });
    safeWriteFile(`${dir}/tenant-dot.json`, JSON.stringify(tenant));
    const receipt = await runDotWake(
      { path: `${dir}/tenant-dot.json`, charter: tenant },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(receipt.outcome).toBe('delivered');
  });

  it('records an unreadable own charter as failed with the real error', async () => {
    safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify({ ...CHARTER, status: 'bogus' }));
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toMatch(/^charter unreadable — Invalid dot charter at .*status/);
    expect(receipt.reason).toContain('| next: pnpm kyberion dot validate repo-guardian');
    expect(receipt.reason).toContain(`| evidence: ${TEST_ROOT}/dots/dot.json`);
    const [row] = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(row.outcome).toBe('failed');
    expect(row.reason).toBe(receipt.reason);
  });

  it('doubles the per-key retry window on each consecutive failure, capped at 6h', async () => {
    expect(dotWakeBackoffMs(1)).toBe(5 * 60_000);
    expect(dotWakeBackoffMs(2)).toBe(10 * 60_000);
    expect(dotWakeBackoffMs(3)).toBe(20 * 60_000);
    expect(dotWakeBackoffMs(20)).toBe(6 * 60 * 60_000);

    const watchCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'watch', paths: ['watched.txt'] }] },
    } as DotCharter;
    writeCharter(watchCharter);
    safeWriteFile(`${TEST_ROOT}/watched.txt`, 'x\n');
    const t0 = new Date('2026-10-02T10:00:00Z');
    const [trigger] = evaluateDotTriggersDue(watchCharter, { rootDir: TEST_ROOT, now: () => t0 });
    const fail = (at: Date) =>
      recordDotWakeOutcome(watchCharter, trigger, 'failed', {
        rootDir: TEST_ROOT,
        now: () => at,
        reason: 'backend down',
      });
    const dueAt = (ms: number) =>
      evaluateDotTriggersDue(watchCharter, {
        rootDir: TEST_ROOT,
        now: () => new Date(t0.getTime() + ms),
      }).length;
    fail(t0);
    expect(dueAt(5 * 60_000 - 1000)).toBe(0);
    expect(dueAt(5 * 60_000)).toBe(1);
    fail(new Date(t0.getTime() + 5 * 60_000));
    // Second consecutive failure: 10 minutes from the last failure.
    expect(dueAt(5 * 60_000 + 10 * 60_000 - 1000)).toBe(0);
    expect(dueAt(5 * 60_000 + 10 * 60_000)).toBe(1);
  });

  it('never counts backend/process-level failures toward the per-dot circuit', () => {
    expect(isDotWakeProcessFailure('backend unavailable')).toBe(true);
    expect(
      isDotWakeProcessFailure(
        'no real reasoning backend in this process — next: run `pnpm reasoning:setup`'
      )
    ).toBe(true);
    expect(isDotWakeProcessFailure('[GOAL_DRIVER] backend lacks generateWithTools')).toBe(true);
    expect(isDotWakeProcessFailure('generateWithTools failed across 3 candidate(s): x')).toBe(true);
    expect(isDotWakeProcessFailure('provider timeout')).toBe(false);

    writeCharter(CHARTER);
    const t0 = new Date('2026-10-02T10:00:00Z');
    const fail = (index: number, reason: string) =>
      recordDotWakeOutcome(
        CHARTER,
        { trigger: { kind: 'cron', cron: '* * * * *' }, key: `cron:k${index}` },
        'failed',
        { rootDir: TEST_ROOT, now: () => new Date(t0.getTime() + index * 60_000), reason }
      );
    for (let index = 0; index < DOT_WAKE_CIRCUIT_THRESHOLD + 3; index += 1) {
      fail(index, `generateWithTools failed across ${index} candidate(s): down`);
    }
    const after = { rootDir: TEST_ROOT, now: () => new Date(t0.getTime() + 9 * 60_000) };
    expect(evaluateDotWakeCircuit(CHARTER, after)).toMatchObject({
      consecutive: 0,
      tripped: false,
    });
    // Interleaved backend failures neither break nor extend a real streak.
    for (let index = 10; index < 10 + DOT_WAKE_CIRCUIT_THRESHOLD; index += 1) {
      fail(index, 'provider timeout');
      fail(index + 100, DOT_WAKE_FAILURE_CATEGORY.backend);
    }
    expect(
      evaluateDotWakeCircuit(CHARTER, {
        rootDir: TEST_ROOT,
        now: () => new Date(t0.getTime() + 200 * 60_000),
      }).consecutive
    ).toBe(DOT_WAKE_CIRCUIT_THRESHOLD);
  });

  it('opens a per-dot circuit after 5 same-reason failures on rotating keys, alerts once, then half-opens', () => {
    const watchCharter = {
      ...CHARTER,
      attention: { triggers: [{ kind: 'watch', paths: ['watched.txt'] }] },
    } as DotCharter;
    writeCharter(watchCharter);
    safeWriteFile(`${TEST_ROOT}/watched.txt`, 'x\n');
    const t0 = new Date('2026-10-02T10:00:00Z');
    // Rotating keys (as ops-alerts.jsonl@mtime did): each key fails once, so
    // per-key backoff alone never holds anything back.
    for (let index = 0; index < DOT_WAKE_CIRCUIT_THRESHOLD; index += 1) {
      recordDotWakeOutcome(
        watchCharter,
        { trigger: { kind: 'watch', paths: ['watched.txt'] }, key: `watch:f@${1000 + index}:9` },
        'failed',
        {
          rootDir: TEST_ROOT,
          now: () => new Date(t0.getTime() + index * 60_000),
          reason: `charter unreadable — line ${index + 3} col 7 | evidence: x`,
        }
      );
    }
    const alerts: unknown[] = [];
    const lastFail = t0.getTime() + (DOT_WAKE_CIRCUIT_THRESHOLD - 1) * 60_000;
    const at = (ms: number) => ({
      rootDir: TEST_ROOT,
      now: () => new Date(lastFail + ms),
      opsAlert: (input: unknown) => void alerts.push(input),
    });
    const circuit = evaluateDotWakeCircuit(watchCharter, at(1000));
    expect(circuit).toMatchObject({ consecutive: 5, tripped: true, open: true });
    expect(normalizeDotWakeReason('line 12 col 7 abcdef12')).toBe('line # col # #');

    // Open: every due trigger is held, and the alert fires once per opening.
    expect(evaluateDotTriggersDue(watchCharter, at(1000))).toHaveLength(0);
    expect(evaluateDotTriggersDue(watchCharter, at(2000))).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      dedupe_key: expect.stringMatching(/^dot-wake-circuit:repo-guardian:[0-9a-f]{12}$/),
    });

    // Past backoff(5) = 80 min: one half-open probe trigger, still one alert.
    const halfOpen = evaluateDotTriggersDue(watchCharter, at(dotWakeBackoffMs(5)));
    expect(halfOpen).toHaveLength(1);
    expect(halfOpen[0].circuit).toBe(true);
    expect(alerts).toHaveLength(1);

    // A delivered wake closes the circuit.
    recordDotWakeOutcome(watchCharter, halfOpen[0], 'delivered', at(dotWakeBackoffMs(5)));
    expect(evaluateDotWakeCircuit(watchCharter, at(dotWakeBackoffMs(5) + 1000)).tripped).toBe(
      false
    );
  });

  it('wakes a dot on its own executor report-back even without a wake trigger', () => {
    writeCharter(CHARTER);
    safeMkdir(`${TEST_ROOT}/active/shared/runtime`, { recursive: true });
    safeWriteFile(
      `${TEST_ROOT}/${DOT_INBOX_PATH}`,
      [
        { dot_id: 'repo-guardian', channel: 'inbox', text: 'not for a channel-less dot' },
        {
          dot_id: 'repo-guardian',
          channel: 'inbox',
          source: 'dot-executor',
          payload: { report_from: 'dot-executor', work_item_id: 'WI-1', status: 'done' },
        },
        {
          dot_id: 'other-dot',
          channel: 'inbox',
          payload: { report_from: 'dot-executor', work_item_id: 'WI-2' },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    const notCron = new Date('2026-10-02T10:16:00Z');
    const due = evaluateDotTriggersDue(CHARTER, { rootDir: TEST_ROOT, now: () => notCron });
    expect(due).toHaveLength(1);
    expect(due[0].trigger.kind).toBe('wake');
    expect(due[0].detail).toContain('WI-1');
  });

  it('never records the process-default stub as a delivery', async () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'claude-cli');
    writeCharter(CHARTER);
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      { rootDir: TEST_ROOT, hasRole: () => true }
    );
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toContain('no real reasoning backend in this process');
    const rows = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(rows.map((row) => row.outcome)).toEqual(['failed']);
    expect(rows.some((row) => String(row.summary ?? '').includes('[STUB]'))).toBe(false);
  });

  it('records backendUnavailable from orchestration as a failed wake', async () => {
    writeCharter(CHARTER);
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      { rootDir: TEST_ROOT, hasRole: () => true, backendUnavailable: 'nothing real here' }
    );
    expect(receipt).toMatchObject({ outcome: 'failed', reason: 'nothing real here' });
  });

  it('degrades a tool loop with no live tool candidate to fenced proposals in the same wake', async () => {
    writeCharter(CHARTER);
    const governed: string[] = [];
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        runLoop: async () => {
          throw new Error(
            '[reasoning-backend:failover] generateWithTools failed across 0 candidate(s): '
          );
        },
        backend: {
          delegateTask: async () =>
            'Fallback.\n```dot-proposals\n[{"title":"Fix","objective":"Do it.","work_shape":"task_session"}]\n```',
        },
        dispatch: (_charter, proposals) => {
          governed.push(...proposals.map((p) => p.title));
          return [];
        },
      }
    );
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.reason).toBe('degraded-fenced');
    expect(governed).toEqual(['Fix']);
    const [row] = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(row.reason).toBe('degraded: tool backend unavailable → fenced proposals; proposals 1');
  });

  it('does not degrade on an unrelated tool-loop failure', async () => {
    writeCharter(CHARTER);
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        runLoop: async () => {
          throw new Error('provider timeout');
        },
        backend: { delegateTask: async () => 'should not run' },
      }
    );
    expect(receipt).toMatchObject({ outcome: 'failed', reason: 'provider timeout' });
  });

  it('falls back to a fenced turn only when no tool-loop turn completed', async () => {
    writeCharter(CHARTER);
    const delegate = vi.fn(async () => 'should not run');
    const receipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        runLoop: async (options) => {
          // Turn 1 got a response (estimated), turn 2's backend call fails.
          options.onPromptVisible?.('x'.repeat(300), 'goal_turn');
          options.estimateTurnTokens?.({
            prompt: 'x'.repeat(300),
            result: { text: 'y'.repeat(30) },
          });
          options.onPromptVisible?.('x'.repeat(300), 'goal_turn');
          throw new Error(
            '[reasoning-backend:failover] generateWithTools failed across 0 candidate(s): '
          );
        },
        backend: { delegateTask: delegate },
      }
    );
    expect(delegate).not.toHaveBeenCalled();
    expect(receipt.outcome).toBe('failed');
    const [row] = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(row).toMatchObject({ outcome: 'failed', turns_run: 1, tokens_used: 110 });
    // The partial loop's tokens count against the daily cap.
    expect(dotTokensUsedToday(CHARTER.dot_id, { rootDir: TEST_ROOT })).toBe(110);
  });

  it('records partial loop tokens even without a turn estimator (no budget)', async () => {
    writeCharter(CHARTER);
    await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        runLoop: async (options) => {
          options.onPromptVisible?.('x'.repeat(300), 'goal_turn');
          options.onPromptVisible?.('x'.repeat(600), 'goal_turn');
          throw new Error('provider timeout');
        },
        backend: { delegateTask: async () => 'unused' },
      }
    );
    // Only the completed first turn's prompt is counted.
    expect(dotTokensUsedToday(CHARTER.dot_id, { rootDir: TEST_ROOT })).toBe(100);
  });

  it('keeps tenant failure prose out of the shared ledger and heartbeat', async () => {
    const tenant: DotCharter = {
      ...CHARTER,
      dot_id: 'tenant-dot',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      runtime: { heartbeat_id: 'dot-tenant-dot' },
    };
    const dir = `${TEST_ROOT}/knowledge/confidential/acme/dots`;
    safeMkdir(dir, { recursive: true });
    safeWriteFile(`${dir}/tenant-dot.json`, JSON.stringify(tenant));
    const receipt = await runDotWake(
      { path: `${dir}/tenant-dot.json`, charter: tenant },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        runLoop: async () => {
          throw new Error('Acme merger memo leaked into the error');
        },
        backend: { delegateTask: async () => 'unused' },
      }
    );
    expect(receipt.reason).toBe('Acme merger memo leaked into the error');
    const [row] = readDotWakeLedger({ rootDir: TEST_ROOT });
    expect(row.reason).toBe('wake failed');
    const heartbeat = JSON.parse(
      safeReadFile(`${TEST_ROOT}/active/shared/runtime/heartbeats/dot-tenant-dot.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(heartbeat.details.error).toBe('wake failed');
    const errorsFile = `${TEST_ROOT}/${dotWakeErrorsPath(tenant)}`;
    expect(errorsFile).toContain('/acme/');
    const [logged] = (safeReadFile(errorsFile, { encoding: 'utf8' }) as string)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logged).toMatchObject({
      dot_id: 'tenant-dot',
      category: 'wake failed',
      reason: 'Acme merger memo leaked into the error',
    });

    // An unreadable tenant charter: category only in the ledger.
    safeWriteFile(`${dir}/tenant-dot.json`, JSON.stringify({ ...tenant, status: 'bogus' }));
    await runDotWake(
      { path: `${dir}/tenant-dot.json`, charter: tenant },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(readDotWakeLedger({ rootDir: TEST_ROOT }).at(-1)?.reason).toBe('charter unreadable');
  });

  it('rejects a tenant charter whose re-read scope names another tenant', async () => {
    const spoof: DotCharter = {
      ...CHARTER,
      dot_id: 'spoof-dot',
      scope: { tier: 'confidential', tenant_slug: 'globex' },
      runtime: { heartbeat_id: 'dot-spoof-dot' },
    };
    const dir = `${TEST_ROOT}/knowledge/confidential/acme/dots`;
    safeMkdir(dir, { recursive: true });
    safeWriteFile(`${dir}/spoof.json`, JSON.stringify(spoof));
    const receipt = await runDotWake(
      { path: `${dir}/spoof.json`, charter: spoof },
      { rootDir: TEST_ROOT, runLoop: async () => fakeResult(1, 5), hasRole: () => true }
    );
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toMatch(/not bound to its tenant directory/);
  });

  it('plumbs registered prompt sections and wake tools through tool and fence wakes', async () => {
    writeCharter(CHARTER);
    const applied: unknown[][] = [];
    const tool: DotWakeTool = {
      name: 'dot_note',
      fence: 'dot-note',
      maxPerWake: 2,
      definition: {
        name: 'dot_note',
        description: 'Record a note.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      parse: (input) =>
        input && typeof (input as { text?: unknown }).text === 'string'
          ? { ok: true, value: (input as { text: string }).text }
          : { ok: false, error: 'text is required' },
      apply: (_charter, values) => {
        applied.push(values);
        return values.includes('bad-apply') ? ['could not store bad-apply'] : [];
      },
    };
    DOT_WAKE_TOOLS.push(tool);
    DOT_PROMPT_SECTIONS.push(
      { id: 'late', order: 20, lines: () => ['SECTION-LATE'] },
      {
        id: 'boom',
        order: 5,
        lines: () => {
          throw new Error('section exploded');
        },
      },
      { id: 'early', order: 10, lines: () => ['SECTION-EARLY'] }
    );

    let systemPrompt = '';
    const toolReceipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        dispatch: () => [],
        runLoop: async (options) => {
          systemPrompt = options.systemPrompt ?? '';
          expect(options.extraTools?.map((t) => t.name)).toEqual([
            'dot_propose_action',
            'dot_note',
          ]);
          options.executeTool!({ name: 'dot_note', input: { text: 'one' } });
          options.executeTool!({ name: 'dot_note', input: {} });
          options.executeTool!({ name: 'dot_note', input: { text: 'two' } });
          expect(
            options.executeTool!({ name: 'dot_note', input: { text: 'three' } }).resultText
          ).toMatch(/limit/);
          return fakeResult(1, 5);
        },
      }
    );
    expect(systemPrompt.indexOf('SECTION-EARLY')).toBeLessThan(
      systemPrompt.indexOf('SECTION-LATE')
    );
    expect(applied).toEqual([['one', 'two']]);
    expect(toolReceipt.tool_errors).toEqual([
      'dot_note: text is required',
      'dot_note: dropped (more than 2 per wake)',
    ]);

    let delegated = '';
    const fenceReceipt = await runDotWake(
      { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
      {
        rootDir: TEST_ROOT,
        hasRole: () => true,
        dispatch: () => [],
        backend: {
          delegateTask: async (prompt: string) => {
            delegated = prompt;
            return 'Done.\n```dot-note\n[{"text":"fenced"},{"text":"bad-apply"}]\n```';
          },
        },
      }
    );
    expect(delegated).toContain('```dot-note');
    expect(applied.at(-1)).toEqual(['fenced', 'bad-apply']);
    expect(fenceReceipt.tool_errors).toEqual(['dot_note: could not store bad-apply']);
    // The wake summary drops registered fences too.
    expect(readDotWakeLedger({ rootDir: TEST_ROOT }).at(-1)?.summary).toBe('Done.');
    expect(applyDotWakeOutputs(CHARTER, {}, { now: () => new Date() })).toEqual([]);
  });
});

describe('dot wake usage attribution', () => {
  it('counts late SDK usage from a timed-out attempt separately from a successful wake', async () => {
    const { AnthropicReasoningBackend } =
      await import('../provider/anthropic-reasoning-backend.js');
    const { metrics, MetricsCollector } = await import('../metrics.js');
    const { computeBudgetUsage } = await import('../governance/org-budget-governor.js');
    const now = new Date('2026-10-04T10:00:00Z');
    const current: DotCharter = {
      ...CHARTER,
      scope: { tier: 'public', tenant_slug: 'acme', organization_id: 'o1' },
      goal: {
        ...CHARTER.goal,
        budget: { wall_clock_ms_per_wake: 1000, token_cap_per_day: 1_000_000 },
      },
    };
    writeCharter(current);
    const response = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 50, output_tokens: 20 },
    };
    let release!: (value: typeof response) => void;
    const late = new Promise<typeof response>((resolve) => {
      release = resolve;
    });
    const backend = new AnthropicReasoningBackend({
      client: {
        messages: {
          create: vi.fn().mockResolvedValueOnce(response).mockReturnValueOnce(late),
          parse: vi.fn(),
        },
      } as unknown as import('@anthropic-ai/sdk').default,
    });
    const rows: Array<Record<string, unknown>> = [];
    const collector = new MetricsCollector({ persist: false });
    let recorded!: () => void;
    const lateRecorded = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    const record = vi
      .spyOn(metrics, 'record')
      .mockImplementation((component, duration, status, extra) => {
        collector.record(component, duration, status, extra);
        rows.push({ timestamp: now.toISOString(), component, ...extra });
        if (rows.length === 2) recorded();
      });
    const loaded = { path: `${TEST_ROOT}/dots/dot.json`, charter: current };
    const deps = {
      rootDir: TEST_ROOT,
      now: () => now,
      hasRole: () => true,
      dispatch: () => [],
      backend,
    };
    const usage = () =>
      computeBudgetUsage(current.scope, {
        rootDir: TEST_ROOT,
        now: () => now,
        listCharters: () => [loaded],
        readMetricsHistory: () => rows,
        readGenerationUnits: () => 0,
      });
    vi.useFakeTimers();
    try {
      expect((await runDotWake(loaded, deps)).outcome).toBe('delivered');
      const before = usage().tokens;
      const timedOut = runDotWake(loaded, deps);
      await vi.advanceTimersByTimeAsync(1001);
      expect((await timedOut).outcome).toBe('failed');
      expect(usage().tokens).toBe(before);
      release(response);
      await lateRecorded;
      expect(usage().tokens).toBe(before + 70);
      expect(rows[0].accounting_id).toEqual(expect.any(String));
      expect(rows[1].accounting_id).not.toBe(rows[0].accounting_id);
      expect(readJsonLines(`${TEST_ROOT}/${DOT_TOKEN_USAGE_PATH}`)).toHaveLength(1);
      expect(getUsageAttribution()).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      record.mockRestore();
    }
  });

  it.each(['loop', 'delegated', 'degraded'] as const)(
    'binds the reread charter in the %s path and clears it afterward',
    async (mode) => {
      const current: DotCharter = {
        ...CHARTER,
        scope: {
          tier: 'public',
          tenant_slug: 'acme',
          organization_id: 'o1',
        },
      };
      writeCharter(current);
      const observed: ReturnType<typeof getUsageAttribution>[] = [];
      const receipt = await runDotWake(
        { path: `${TEST_ROOT}/dots/dot.json`, charter: CHARTER },
        {
          rootDir: TEST_ROOT,
          hasRole: () => true,
          dispatch: () => [],
          backend: {
            delegateTask: async () => {
              await Promise.resolve();
              observed.push(getUsageAttribution());
              return 'ok';
            },
          },
          ...(mode === 'delegated'
            ? {}
            : {
                runLoop: async () => {
                  await Promise.resolve();
                  observed.push(getUsageAttribution());
                  if (mode === 'degraded') throw new Error('backend lacks generateWithTools');
                  return fakeResult(1, 5);
                },
              }),
        }
      );
      expect(receipt.outcome).toBe('delivered');
      expect(observed).toHaveLength(mode === 'degraded' ? 2 : 1);
      for (const attribution of observed)
        expect(attribution).toEqual({
          actor_id: `dot:${current.dot_id}`,
          accounting_id: expect.any(String),
          scope: { ...current.scope, scope_kind: 'organization' },
        });
      const charges = readJsonLines<{ accounting_id?: string }>(
        `${TEST_ROOT}/${DOT_TOKEN_USAGE_PATH}`
      );
      expect(charges.length).toBeGreaterThan(0);
      expect(charges.every((charge) => charge.accounting_id === observed[0]?.accounting_id)).toBe(
        true
      );
      expect(new Set(observed.map((row) => row?.accounting_id)).size).toBe(1);
      expect(getUsageAttribution()).toBeUndefined();
    }
  );
});
