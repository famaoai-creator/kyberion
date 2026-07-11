import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realFsSecureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    fs.mkdirSync(dirPath, { recursive: options?.recursive !== false }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));
vi.mock('./secure-io.js', () => realFsSecureIo);
vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('./surface-coordination-store.js', () => ({ enqueueSurfaceOutboxMessage: enqueue }));

const imessage = vi.hoisted(() => vi.fn());
vi.mock('./imessage-bridge.js', () => ({ sendIMessage: imessage }));

describe('operator notifications (E2E-04 Task 2)', () => {
  beforeEach(() => {
    process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS = '1';
  });
  let tmpRoot: string;
  let mod: typeof import('./operator-notifications.js');

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-notify-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
    vi.resetModules();
    mod = await import('./operator-notifications.js');
    mod.resetOperatorNotificationRateLimiter();
    enqueue.mockReset();
    imessage.mockReset();
  });

  afterEach(() => {
    delete process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS;
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePrefs(prefs: unknown): void {
    const filePath = path.join(tmpRoot, 'knowledge', 'personal', 'notification-preferences.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(prefs));
  }

  it('routes per_event over default_channel', async () => {
    writePrefs({
      default_channel: { surface: 'slack', target: 'C_DEFAULT' },
      per_event: { question: { surface: 'slack', target: 'C_QUESTIONS' } },
    });
    const sent = await mod.notifyOperator('question', { title: 'q', body: 'b' });
    expect(sent).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].channel).toBe('C_QUESTIONS');
    expect(enqueue.mock.calls[0][0].surface).toBe('slack');
  });

  it('falls back to default_channel for unset events', async () => {
    writePrefs({ default_channel: { surface: 'telegram', target: '12345' } });
    const sent = await mod.notifyOperator('mission_completed', { title: 'done', body: 'ok' });
    expect(sent).toBe(true);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ surface: 'telegram', channel: '12345' });
  });

  it('mute suppresses delivery and returns false', async () => {
    writePrefs({
      default_channel: { surface: 'slack', target: 'C_DEFAULT' },
      per_event: { ops_alert: 'mute' },
    });
    const sent = await mod.notifyOperator('ops_alert', { title: 'noisy', body: 'x' });
    expect(sent).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records to ops-alert JSONL and returns false when nothing is configured', async () => {
    const sent = await mod.notifyOperator('approval_required', { title: 'apr', body: 'x' });
    expect(sent).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    const logPath = path.join(tmpRoot, 'active', 'shared', 'observability', 'ops-alerts.jsonl');
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    expect(record.kind).toBe('operator_notification_undelivered');
    expect(record.reason).toBe('no_channel_configured');
  });

  it('rate-limits repeats of the same event×correlation', async () => {
    writePrefs({ default_channel: { surface: 'slack', target: 'C1' } });
    const first = await mod.notifyOperator('question', {
      title: 'q',
      body: 'b',
      correlation_id: 'INT-1',
    });
    const second = await mod.notifyOperator('question', {
      title: 'q',
      body: 'b',
      correlation_id: 'INT-1',
    });
    const other = await mod.notifyOperator('question', {
      title: 'q',
      body: 'b',
      correlation_id: 'INT-2',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(other).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('delivers imessage directly via sendIMessage', async () => {
    writePrefs({ default_channel: { surface: 'imessage', target: '+819012345678' } });
    const sent = await mod.notifyOperator('deliverable_ready', { title: 'pkg', body: 'ready' });
    expect(sent).toBe(true);
    expect(imessage).toHaveBeenCalledTimes(1);
    expect(imessage.mock.calls[0][0].recipient).toBe('+819012345678');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('save/load round-trips preferences', () => {
    const filePath = mod.saveNotificationPreferences({
      default_channel: { surface: 'slack', target: 'C9' },
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(mod.loadNotificationPreferences().default_channel?.target).toBe('C9');
  });
});
