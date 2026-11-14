import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeAppendFileSync,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import {
  isSessionHookAuditRow,
  isSessionHookMetricsRow,
  sessionHookProvenance,
} from '../libs/core/provider/session-hook-provenance.js';
import {
  LIVE_STATE_ROOTS,
  grewOnlyBySessionHooks,
  snapshot,
  summarizeLeaks,
} from './vitest-active-leak-guard.js';

const FIXTURE_ROOT = pathResolver.sharedTmp(`vitest-leak-guard-${process.pid}`);

function write(relative: string, content = 'x'): void {
  const file = path.join(FIXTURE_ROOT, relative);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, content);
}

describe('vitest live-state leak guard', () => {
  beforeEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
    write('active/missions/existing.json');
    write('knowledge/personal/README.md');
  });

  afterEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('snapshots the gitignored live roots outside active/', () => {
    expect(LIVE_STATE_ROOTS).toEqual(
      expect.arrayContaining([
        'active',
        'knowledge/personal',
        'knowledge/confidential',
        'customer',
        'work/metrics',
      ])
    );
  });

  it('reports files created in the tenant registry and customer overlays', () => {
    const before = snapshot(FIXTURE_ROOT);
    write('knowledge/personal/tenants/default.json', '{}');
    write('knowledge/confidential/probe-co/notes.md');
    write('customer/probe-co/customer.json');
    write('active/shared/tmp/scratch.json');
    write('knowledge/public/ignored.md');

    const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT));

    expect(leaks.created).toEqual([
      'customer/probe-co/customer.json',
      'knowledge/confidential/probe-co/notes.md',
      'knowledge/personal/tenants/default.json',
    ]);
    expect(leaks.grown).toEqual([]);
    expect(leaks.by_area).toEqual({
      'customer/probe-co/customer.json': 1,
      'knowledge/confidential/probe-co/notes.md': 1,
      'knowledge/personal/tenants/default.json': 1,
    });
  });

  it('reports a tracked personal-tier file that grew', () => {
    const before = snapshot(FIXTURE_ROOT);
    write('knowledge/personal/README.md', 'grown');

    expect(summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT).grown).toEqual([
      'knowledge/personal/README.md',
    ]);
  });

  describe('agent-session hook appends to the live audit chain', () => {
    const AUDIT = 'active/shared/logs/audit/audit-2026-11-13.jsonl';
    const existingRow = { id: 'AUD-OLD-1', agentId: 'mission_controller', action: 'x' };

    // The row shape recordPostToolUse writes from a hook process (no VITEST in its env).
    const hookRow = (n: number) => ({
      id: `AUD-HOOK-${n}`,
      timestamp: '2026-11-13T00:00:00.000Z',
      agentId: 'claude-code',
      action: 'claude_code_tool',
      operation: 'Bash',
      result: 'completed',
      metadata: {
        tool: 'Bash',
        command: 'pnpm exec vitest run',
        cwd: '/repo',
        session_hook: sessionHookProvenance('claude', 'PostToolUse', 'session-abc', {}),
      },
      previousHash: 'a',
      currentHash: 'b',
    });
    // The same tool row written by a test: no provenance stamp.
    const testRow = { ...hookRow(99), metadata: { tool: 'Bash', command: 'fixture' } };

    const jsonl = (...rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    const append = (content: string) => safeAppendFileSync(path.join(FIXTURE_ROOT, AUDIT), content);

    beforeEach(() => {
      write(AUDIT, jsonl(existingRow));
    });

    it('stamps hook rows only outside Vitest and only with a host session id', () => {
      expect(sessionHookProvenance('claude', 'Stop', 's1', {})).toEqual({
        host: 'claude',
        event: 'Stop',
        session_id: 's1',
      });
      expect(sessionHookProvenance('claude', 'Stop', 's1', { VITEST: 'true' })).toBeUndefined();
      expect(sessionHookProvenance('claude', 'Stop', '', {})).toBeUndefined();
      expect(sessionHookProvenance('claude', 'Stop', undefined, {})).toBeUndefined();
    });

    it('refuses the stamp when any test-run marker is set (a test child spawned with VITEST: "")', () => {
      for (const env of [
        { VITEST: '', KYBERION_VITEST_RUN_ID: 'run-1' },
        { VITEST: '', VITEST_POOL_ID: '3' },
        { VITEST_WORKER_ID: '2' },
      ]) {
        expect(sessionHookProvenance('claude', 'PostToolUse', 's1', env)).toBeUndefined();
      }
    });

    it('does not report growth made only of stamped session-hook rows', () => {
      const before = snapshot(FIXTURE_ROOT);
      append(jsonl(hookRow(1), hookRow(2)));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.grown).toEqual([]);
      expect(leaks.created).toEqual([]);
      expect(leaks.session_hook_appends).toEqual([AUDIT]);
    });

    it('reports an unstamped append to the same file', () => {
      const before = snapshot(FIXTURE_ROOT);
      append(jsonl(testRow));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.grown).toEqual([AUDIT]);
      expect(leaks.session_hook_appends).toEqual([]);
    });

    it('reports a mixed append (hook rows plus one test row) and names the file', () => {
      const before = snapshot(FIXTURE_ROOT);
      append(jsonl(hookRow(1), testRow, hookRow(2)));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.grown).toEqual([AUDIT]);
      expect(leaks.by_area).toEqual({ 'active/shared/logs/audit': 1 });
      // The first unattributed line and its row kind, never its payload.
      expect(leaks.grown_unattributed[AUDIT]).toEqual({
        reason: 'row is not an attributed session-hook row',
        line: 2,
        agentId: 'claude-code',
        action: 'claude_code_tool',
      });
      expect(JSON.stringify(leaks.grown_unattributed)).not.toContain('fixture');
    });

    it('reports a replaced file that regrew with stamped rows (inode changed)', () => {
      const before = snapshot(FIXTURE_ROOT);
      write(`${AUDIT}.next`, jsonl(existingRow, hookRow(1)));
      safeRmSync(path.join(FIXTURE_ROOT, AUDIT));
      safeMoveSync(path.join(FIXTURE_ROOT, `${AUDIT}.next`), path.join(FIXTURE_ROOT, AUDIT));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.grown).toEqual([AUDIT]);
      expect(leaks.grown_unattributed[AUDIT]?.reason).toContain('inode changed');
    });

    it('drops a created lock gone at report time, and reports one that still exists', () => {
      const before = snapshot(FIXTURE_ROOT);
      write('active/shared/runtime/locks/audit-chain-global.lock', '{"pid":1}');
      write('active/shared/runtime/locks/stale.lock', '{"pid":2}');
      const after = snapshot(FIXTURE_ROOT);
      safeRmSync(path.join(FIXTURE_ROOT, 'active/shared/runtime/locks/audit-chain-global.lock'));

      const leaks = summarizeLeaks(before, after, FIXTURE_ROOT);

      expect(leaks.transient_locks).toEqual([
        'active/shared/runtime/locks/audit-chain-global.lock',
      ]);
      expect(leaks.created).toEqual(['active/shared/runtime/locks/stale.lock']);
    });

    it('a created non-lock file gone at report time is still reported', () => {
      const before = snapshot(FIXTURE_ROOT);
      write('active/missions/gone.json');
      const after = snapshot(FIXTURE_ROOT);
      safeRmSync(path.join(FIXTURE_ROOT, 'active/missions/gone.json'));

      expect(summarizeLeaks(before, after, FIXTURE_ROOT).created).toEqual([
        'active/missions/gone.json',
      ]);
    });

    it('rejects a stamp on a row that is not a hook-recorded action', () => {
      const forged = { ...hookRow(1), agentId: 'mission_controller' };
      const wrongEvent = {
        ...hookRow(2),
        metadata: {
          ...hookRow(2).metadata,
          session_hook: { host: 'claude', event: 'Stop', session_id: 's' },
        },
      };
      expect(isSessionHookAuditRow(hookRow(1))).toBe(true);
      expect(isSessionHookAuditRow(forged)).toBe(false);
      expect(isSessionHookAuditRow(wrongEvent)).toBe(false);
    });

    it('still reports a created file even when all its rows are stamped', () => {
      const before = snapshot(FIXTURE_ROOT);
      write('active/shared/logs/audit/audit-2026-11-14.jsonl', jsonl(hookRow(1)));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.created).toEqual(['active/shared/logs/audit/audit-2026-11-14.jsonl']);
      expect(leaks.session_hook_appends).toEqual([]);
      // Named as the likely rollover cause, but still counted as created.
      expect(leaks.created_session_hook_only).toEqual([
        'active/shared/logs/audit/audit-2026-11-14.jsonl',
      ]);
    });

    it('names a created tenant audit-mirror file holding only stamped rows as a rollover too', () => {
      const MIRROR =
        'active/shared/runtime/audit-mirror/confidential/probe-co/audit-2026-11-14.jsonl';
      const before = snapshot(FIXTURE_ROOT);
      write('active/shared/logs/audit/audit-2026-11-14.jsonl', jsonl(hookRow(1)));
      write(MIRROR, jsonl(hookRow(1)));

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.created).toHaveLength(2);
      expect(leaks.created_session_hook_only).toEqual([
        'active/shared/logs/audit/audit-2026-11-14.jsonl',
        MIRROR,
      ]);
    });

    it('does not name a created audit file with an unstamped row as a rollover', () => {
      const before = snapshot(FIXTURE_ROOT);
      write('active/shared/logs/audit/audit-2026-11-14.jsonl', jsonl(hookRow(1), testRow));
      write('active/missions/new.jsonl', jsonl(hookRow(2))); // outside the audit log dir

      const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);

      expect(leaks.created).toHaveLength(2);
      expect(leaks.created_session_hook_only).toEqual([]);
    });

    it('fails closed when the appended region cannot be parsed', () => {
      for (const bad of [
        `${JSON.stringify(hookRow(1))}\n{"truncated":`, // torn last row
        `${JSON.stringify(hookRow(1))}\nnot json\n`, // unparseable line
      ]) {
        write(AUDIT, jsonl(existingRow));
        const before = snapshot(FIXTURE_ROOT);
        append(bad);
        expect(summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT).grown).toEqual([AUDIT]);
      }
    });

    it('fails closed when the appended region continues a row it never saw whole', () => {
      write(AUDIT, `${JSON.stringify(existingRow)}\n{"partial":`);
      const before = snapshot(FIXTURE_ROOT);
      append(`1}\n${JSON.stringify(hookRow(1))}\n`);

      expect(summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT).grown).toEqual([AUDIT]);
    });

    it('fails closed when the grown file cannot be read', () => {
      expect(grewOnlyBySessionHooks(path.join(FIXTURE_ROOT, 'missing.jsonl'), 0, 10)).toBe(false);
    });
  });

  describe('Stop-hook CLI usage rows in the execution-metrics ledger', () => {
    const LEDGER = 'work/metrics/execution-metrics.jsonl';
    // The row metrics.record('claude-code-cli', …) persists from recordCliUsage.
    const usageRow = (stamp: unknown = sessionHookProvenance('claude', 'Stop', 's-1', {})) => ({
      component: 'claude-code-cli',
      duration_ms: 0,
      status: 'success',
      timestamp: '2026-11-13T00:00:00.000Z',
      memory: { heapUsedMB: 1, heapTotalMB: 2, rssMB: 3 },
      model: 'claude-opus-4-8',
      agent: 'claude-code-cli',
      turns: 1,
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      cause: 'unattributed',
      ...(stamp ? { session_hook: stamp } : {}),
    });
    const otherRow = { ...usageRow(), component: 'wisdom-actuator', agent: 'wisdom-actuator' };
    const jsonl = (...rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

    beforeEach(() => {
      write(LEDGER, jsonl(otherRow));
    });

    const grownAfter = (content: string) => {
      const before = snapshot(FIXTURE_ROOT);
      safeAppendFileSync(path.join(FIXTURE_ROOT, LEDGER), content);
      return summarizeLeaks(before, snapshot(FIXTURE_ROOT), FIXTURE_ROOT);
    };

    it('does not report growth made only of stamped Stop usage rows', () => {
      const leaks = grownAfter(jsonl(usageRow(), usageRow()));
      expect(leaks.grown).toEqual([]);
      expect(leaks.session_hook_appends).toEqual([LEDGER]);
    });

    it('reports a mixed append (stamped usage row plus an unstamped metrics row)', () => {
      expect(grownAfter(jsonl(usageRow(), usageRow(null))).grown).toEqual([LEDGER]);
    });

    it('reports a stamp on a row kind the Stop hook does not write', () => {
      const wrongComponent = { ...otherRow, session_hook: usageRow().session_hook };
      const wrongEvent = usageRow({ host: 'claude', event: 'PostToolUse', session_id: 's-1' });
      // An audit-shaped stamp location (metadata) is not the metrics row's.
      const nested = { ...usageRow(null), metadata: { session_hook: usageRow().session_hook } };
      for (const row of [wrongComponent, wrongEvent, nested]) {
        expect(isSessionHookMetricsRow(row)).toBe(false);
        write(LEDGER, jsonl(otherRow));
        expect(grownAfter(jsonl(row)).grown).toEqual([LEDGER]);
      }
      expect(isSessionHookMetricsRow(usageRow())).toBe(true);
    });
  });
});
