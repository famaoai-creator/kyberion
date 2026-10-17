import { afterEach, describe, expect, it } from 'vitest';

import { readJsonLines } from '../foundation/json.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  appendDotInboxEntry,
  compactDotInbox,
  dotInboxWakeKey,
  DOT_INBOX_PATH,
  DOT_INBOX_RECEIPT_SCAN_BYTES,
  DOT_WAKE_CHANNELS,
  isDotWakeChannel,
} from './dot-inbox.js';

const TEST_ROOT = 'active/shared/tmp/dot-inbox-tests';

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('appendDotInboxEntry', () => {
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
});
