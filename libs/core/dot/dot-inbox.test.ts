import { afterEach, describe, expect, it } from 'vitest';

import { readJsonLines } from '../foundation/json.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  appendDotInboxEntry,
  DOT_INBOX_PATH,
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

  it('does not emit another wake when the existing delivery evidence is corrupt', () => {
    const input = { channel: 'inbox', dot_id: 'dot-a', idempotency_key: 'report-1' };
    appendDotInboxEntry(input, { rootDir: TEST_ROOT });
    const file = `${TEST_ROOT}/${DOT_INBOX_PATH}`;
    const corrupt = `${String(safeReadFile(file, { encoding: 'utf8' }))}{broken\n`;
    safeWriteFile(file, corrupt);

    expect(() => appendDotInboxEntry(input, { rootDir: TEST_ROOT })).toThrow();
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(corrupt);
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
