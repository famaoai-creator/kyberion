import { afterEach, describe, expect, it } from 'vitest';

import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { streamJsonLines } from '../jsonl-read.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  appendDotInboxEntry as appendScopedDotInboxEntry,
  type DotInboxEntryInput,
  type DotInboxAppendDeps,
  compactDotInbox,
  dotInboxWakeKey,
  DOT_INBOX_PATH,
  DOT_INBOX_RECEIPT_SCAN_BYTES,
  DOT_WAKE_CHANNELS,
  isDotWakeChannel,
  dotInboxPath,
  dotInboxRowWakesCharter,
  setDotInboxTestHooks,
} from './dot-inbox.js';

const TEST_ROOT = 'active/shared/tmp/dot-inbox-tests';
const appendDotInboxEntry = (input: DotInboxEntryInput, deps?: DotInboxAppendDeps) =>
  appendScopedDotInboxEntry({ ...input, scope: input.scope ?? { tier: 'public' } }, deps);

afterEach(() => {
  setDotInboxTestHooks({});
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('appendDotInboxEntry', () => {
  it('requires an explicit trusted scope before persisting content', () => {
    expect(() =>
      appendScopedDotInboxEntry(
        { channel: 'slack', text: 'unknown-origin' },
        { rootDir: TEST_ROOT }
      )
    ).toThrow('DOT_INBOX_SCOPE_REQUIRED');
  });
  it('keeps private channel content in its tier and tenant lane and refuses cross-scope wake', () => {
    const scope = {
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
    };
    const entry = appendDotInboxEntry(
      { channel: 'slack', text: 'private synthetic', scope },
      { rootDir: TEST_ROOT }
    );
    const charter = (other: Record<string, unknown>) =>
      ({
        dot_id: 'test',
        scope: other,
        attention: { triggers: [{ kind: 'wake', channels: ['slack'] }] },
      }) as never;
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toEqual([]);
    expect(readJsonLines(`${TEST_ROOT}/${dotInboxPath(scope)}`)).toEqual([entry]);
    expect(dotInboxRowWakesCharter(entry, charter(scope))).toBe(true);
    for (const other of [
      { tier: 'public' },
      { ...scope, tenant_slug: 'tenant-b' },
      { ...scope, organization_id: 'org-b' },
      { tier: 'personal', owner_nhi: 'owner-a' },
    ])
      expect(dotInboxRowWakesCharter(entry, charter(other))).toBe(false);
    expect(dotInboxRowWakesCharter({ channel: 'slack' }, charter({ tier: 'public' }))).toBe(false);
  });
  it('appends a validated broadcast row', () => {
    const entry = appendDotInboxEntry(
      { channel: 'slack', text: 'hello', source: 'test' },
      { rootDir: TEST_ROOT, now: () => new Date('2026-10-03T00:00:00Z') }
    );
    expect(entry.channel).toBe('slack');
    expect(entry.enqueued_at).toBe('2026-10-03T00:00:00.000Z');
    expect(entry.dot_id).toBeUndefined();
    const rows = readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'slack', text: 'hello', source: 'test' });
  });

  it('writes an addressed row when dot_id is given', () => {
    const entry = appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'ping' },
      { rootDir: TEST_ROOT }
    );
    expect(entry.dot_id).toBe('repo-guardian');
  });

  it('returns the original delivery receipt when a producer retries after an uncertain append', () => {
    const input = {
      channel: 'inbox',
      dot_id: 'repo-guardian',
      source: 'dot-executor',
      idempotency_key: 'report:work-1:attempt-1',
      text: 'Work complete',
    };
    const first = appendDotInboxEntry(input, {
      rootDir: TEST_ROOT,
      now: () => new Date('2026-10-03T00:00:00Z'),
    });
    const retried = appendDotInboxEntry(input, {
      rootDir: TEST_ROOT,
      now: () => new Date('2026-10-03T01:00:00Z'),
    });

    expect(retried).toEqual(first);
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toHaveLength(1);
  });

  it('scopes a delivery identity to the addressed dot, channel and producer', () => {
    const input = {
      channel: 'inbox',
      dot_id: 'dot-a',
      source: 'producer-a',
      idempotency_key: 'report-1',
    };
    for (const change of [
      {},
      { dot_id: 'dot-b' },
      { channel: 'slack' },
      { source: 'producer-b' },
    ]) {
      appendDotInboxEntry({ ...input, ...change }, { rootDir: TEST_ROOT });
    }
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toHaveLength(4);
  });

  it('skips a torn line from any producer when looking up a delivery receipt', () => {
    const input = { channel: 'inbox', dot_id: 'dot-a', idempotency_key: 'report-1' };
    const first = appendDotInboxEntry(input, { rootDir: TEST_ROOT });
    const file = `${TEST_ROOT}/${DOT_INBOX_PATH}`;
    const corrupt = `${String(safeReadFile(file, { encoding: 'utf8' }))}{broken\n`;
    safeWriteFile(file, corrupt);

    // The receipt survives a torn neighbour: no second wake.
    expect(appendDotInboxEntry(input, { rootDir: TEST_ROOT })).toEqual(first);
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(corrupt);
    // Another tenant's idempotent report is not blocked by the torn line.
    const other = appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'dot-b', idempotency_key: 'report-9' },
      { rootDir: TEST_ROOT }
    );
    expect(other.dot_id).toBe('dot-b');
    expect(readJsonLines(file, { onMalformed: 'skip' })).toHaveLength(2);
  });

  it('bounds the receipt lookup to the newest window of the shared inbox', () => {
    const file = `${TEST_ROOT}/${DOT_INBOX_PATH}`;
    const old = { channel: 'inbox', dot_id: 'dot-a', idempotency_key: 'old-report' };
    appendDotInboxEntry(old, { rootDir: TEST_ROOT });
    const filler = `${JSON.stringify({ channel: 'slack', text: 'x'.repeat(1_000) })}\n`;
    const fillerCount = Math.ceil(DOT_INBOX_RECEIPT_SCAN_BYTES / filler.length) + 1;
    safeWriteFile(
      file,
      `${String(safeReadFile(file, { encoding: 'utf8' }))}${filler.repeat(fillerCount)}`
    );
    const recent = { channel: 'inbox', dot_id: 'dot-a', idempotency_key: 'recent-report' };
    const first = appendDotInboxEntry(recent, { rootDir: TEST_ROOT });
    expect(appendDotInboxEntry(recent, { rootDir: TEST_ROOT })).toEqual(first);
    // Behind more than the window, a key counts as a new delivery (documented bound).
    appendDotInboxEntry(old, { rootDir: TEST_ROOT });
    const rows = readJsonLines<{ idempotency_key?: string }>(file);
    expect(rows.filter((row) => row.idempotency_key === 'old-report')).toHaveLength(2);
    expect(rows.filter((row) => row.idempotency_key === 'recent-report')).toHaveLength(1);
  });

  it('rejects empty, unsafe or unbounded delivery identities', () => {
    for (const key of ['', '../report', 'report\n1', 'x'.repeat(201)]) {
      expect(() =>
        appendDotInboxEntry({ channel: 'inbox', idempotency_key: key }, { rootDir: TEST_ROOT })
      ).toThrow(/idempotency_key/);
    }
  });

  it('does not treat a matching but malformed row as delivery evidence', () => {
    const input = { channel: 'inbox', dot_id: 'dot-a', idempotency_key: 'report-1' };
    safeWriteFile(
      `${TEST_ROOT}/${DOT_INBOX_PATH}`,
      `${JSON.stringify({ ...input, enqueued_at: 2 })}\n`
    );
    expect(() => appendDotInboxEntry(input, { rootDir: TEST_ROOT })).toThrow(/invalid timestamp/);
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toHaveLength(1);
  });

  it('rejects channels outside the wake enum', () => {
    expect(() => appendDotInboxEntry({ channel: 'email' }, { rootDir: TEST_ROOT })).toThrow(
      /DOT_INBOX/
    );
    expect(() => appendDotInboxEntry({ channel: '' }, { rootDir: TEST_ROOT })).toThrow(/DOT_INBOX/);
  });

  it('truncates text and caps payload size', () => {
    const entry = appendDotInboxEntry(
      { channel: 'slack', text: 'x'.repeat(5_000) },
      { rootDir: TEST_ROOT }
    );
    expect(entry.text).toHaveLength(2_000);
    expect(() =>
      appendDotInboxEntry(
        { channel: 'slack', payload: { blob: 'y'.repeat(8_000) } },
        { rootDir: TEST_ROOT }
      )
    ).toThrow(/4KB/);
  });
});

describe('isDotWakeChannel', () => {
  it('accepts exactly the charter wake enum', () => {
    for (const channel of DOT_WAKE_CHANNELS) expect(isDotWakeChannel(channel)).toBe(true);
    expect(isDotWakeChannel('chronos')).toBe(false);
    expect(isDotWakeChannel('terminal')).toBe(false);
  });
});

describe('compactDotInbox', () => {
  const CHARTER = {
    kind: 'dot-charter',
    dot_id: 'repo-guardian',
    version: '1.0.0',
    title: 'Repo guardian',
    purpose: 'Keep the repository healthy.',
    status: 'active',
    scope: { tier: 'public' },
    goal: {
      statement: 'g',
      budget: { max_turns_per_wake: 1, wall_clock_ms_per_wake: 1000, token_cap_per_day: 1 },
    },
    attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-repo-guardian' },
  };
  const inbox = (root: string) => `${root}/${DOT_INBOX_PATH}`;
  const ledger = (root: string) => `${root}/active/shared/runtime/dot-wake-ledger.jsonl`;

  it('tombstones consumed rows in place — surviving rows keep exact keys', () => {
    const pending = appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'pending' },
      { rootDir: TEST_ROOT }
    );
    const consumed = appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'consumed' },
      { rootDir: TEST_ROOT }
    );
    const before = (safeReadFile(inbox(TEST_ROOT)) as string).split('\n');
    // row indices are 1-based in the raw split; pending=1, consumed=2
    const consumedKey = dotInboxWakeKey(2, before[1]!);
    const pendingKey = dotInboxWakeKey(1, before[0]!);

    safeMkdir(`${TEST_ROOT}/active/shared/runtime`, { recursive: true });
    safeWriteFile(
      ledger(TEST_ROOT),
      JSON.stringify({
        dot_id: 'repo-guardian',
        trigger_key: consumedKey,
        outcome: 'delivered',
        fired_at: new Date().toISOString(),
      }) + '\n'
    );
    safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify(CHARTER) + '\n');

    const r = compactDotInbox({ rootDir: TEST_ROOT, compactMinBytes: 1 });
    expect(r.tombstoned).toBe(1);

    const after = (safeReadFile(inbox(TEST_ROOT)) as string).split('\n');
    expect(after).toHaveLength(before.length); // positions never move
    expect(after[1]).toBe('{"tombstone":true}');
    expect(after[0]).toBe(before[0]); // pending row byte-identical
    // surviving row re-derives the identical wake key — no re-fire, no state loss
    expect(dotInboxWakeKey(1, after[0]!)).toBe(pendingKey);
  });

  it('never tombstones a row that still has an unconsumed consumer', () => {
    appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'pending' },
      { rootDir: TEST_ROOT }
    );
    safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify(CHARTER) + '\n');
    const r = compactDotInbox({ rootDir: TEST_ROOT, compactMinBytes: 1 });
    expect(r.tombstoned).toBe(0);
    expect(safeReadFile(inbox(TEST_ROOT)) as string).not.toContain('tombstone');
  });

  it('streams a chunked compaction with blank, CRLF and torn lines — wake keys unchanged', () => {
    const row = (text: string): string =>
      JSON.stringify({
        channel: 'inbox',
        dot_id: 'repo-guardian',
        scope: { tier: 'public' },
        text,
        enqueued_at: new Date().toISOString(),
      });
    // blank line, CRLF terminator, a malformed line and a torn tail
    const raw = `${row('a')}\n\n${row('consumed')}\r\n${row('b')}\nnot-json\n${row('c')}\n{"torn":`;
    safeMkdir(`${TEST_ROOT}/active/shared/runtime`, { recursive: true });
    safeWriteFile(inbox(TEST_ROOT), raw);
    // Keys exactly as the old whole-file consumer derived them.
    const oldLines = raw.split(/\r?\n/);
    const oldKeys = new Map<number, string>();
    oldLines.forEach((line, i) => {
      if (line.trim()) oldKeys.set(i + 1, dotInboxWakeKey(i + 1, line));
    });
    // The streamed reader numbers lines identically.
    const streamed = [
      ...streamJsonLines<{ text?: string; n: number; line: string }>(inbox(TEST_ROOT), {
        onMalformed: 'skip',
        chunkBytes: 11,
        map: (value, n, line) => ({ ...(value as { text?: string }), n, line }),
      }),
    ];
    expect(streamed.map((r) => r.n)).toEqual([1, 3, 4, 6]);
    for (const r of streamed) expect(dotInboxWakeKey(r.n, r.line)).toBe(oldKeys.get(r.n));

    safeWriteFile(
      ledger(TEST_ROOT),
      JSON.stringify({
        dot_id: 'repo-guardian',
        trigger_key: oldKeys.get(3),
        outcome: 'delivered',
        fired_at: new Date().toISOString(),
      }) + '\n'
    );
    safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify(CHARTER) + '\n');

    const r = compactDotInbox({ rootDir: TEST_ROOT, compactMinBytes: 1, chunkBytes: 17 });
    expect(r.tombstoned).toBe(1);
    expect(r.scanned).toBe(oldLines.length);

    const after = (safeReadFile(inbox(TEST_ROOT)) as string).split('\n');
    expect(after[2]).toBe('{"tombstone":true}');
    // Every surviving line sits at its old index with identical text, so the
    // keys the consumer re-derives are unchanged.
    oldLines.forEach((line, i) => {
      if (i === 2) return;
      expect(after[i]).toBe(line);
      if (line.trim()) expect(dotInboxWakeKey(i + 1, after[i]!)).toBe(oldKeys.get(i + 1));
    });
  });
  it('never overwrites a row appended mid-compaction — aborts and keeps it', () => {
    appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'pending' },
      { rootDir: TEST_ROOT }
    );
    appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'consumed' },
      { rootDir: TEST_ROOT }
    );
    const before = (safeReadFile(inbox(TEST_ROOT)) as string).split('\n');
    safeWriteFile(
      ledger(TEST_ROOT),
      JSON.stringify({
        dot_id: 'repo-guardian',
        trigger_key: dotInboxWakeKey(2, before[1]!),
        outcome: 'delivered',
        fired_at: new Date().toISOString(),
      }) + '\n'
    );
    safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify(CHARTER) + '\n');
    // A writer outside the lock lands a wake after the audit, before the move.
    setDotInboxTestHooks({
      beforeCompactMove: (file) =>
        appendJsonLine(file, {
          channel: 'inbox',
          dot_id: 'repo-guardian',
          text: 'late',
          scope: { tier: 'public' },
        }),
    });
    expect(() => compactDotInbox({ rootDir: TEST_ROOT, compactMinBytes: 1 })).toThrow(
      /grew during compaction/
    );
    const after = readJsonLines<{ text?: string }>(inbox(TEST_ROOT));
    expect(after.map((r) => r.text)).toEqual(['pending', 'consumed', 'late']);

    // Through the append path (compaction after the locked append): the wake survives too.
    setDotInboxTestHooks({
      beforeCompactMove: (file) =>
        appendJsonLine(file, {
          channel: 'inbox',
          dot_id: 'repo-guardian',
          text: 'late-2',
          scope: { tier: 'public' },
        }),
    });
    appendDotInboxEntry(
      { channel: 'inbox', dot_id: 'repo-guardian', text: 'plain' },
      { rootDir: TEST_ROOT, compactMinBytes: 1 }
    );
    expect(readJsonLines<{ text?: string }>(inbox(TEST_ROOT)).map((r) => r.text)).toEqual([
      'pending',
      'consumed',
      'late',
      'plain',
      'late-2',
    ]);
    setDotInboxTestHooks({});
    expect(compactDotInbox({ rootDir: TEST_ROOT, compactMinBytes: 1 }).tombstoned).toBe(1);
  });
});
