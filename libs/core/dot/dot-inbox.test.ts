import { afterEach, describe, expect, it } from 'vitest';

import { readJsonLines } from '../foundation/json.js';
import { safeRmSync } from '../secure-io.js';
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
