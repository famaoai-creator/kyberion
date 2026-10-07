import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const realFsSecureIo = vi.hoisted(() => ({
  assertSafeRepositoryPath: (
    filePath: string,
    options: { allowMissingLeaf?: boolean; rootDir?: string } = {}
  ) => {
    const root = path.resolve(options.rootDir ?? process.env.KYBERION_ROOT ?? process.cwd());
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${filePath}`
      );
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(
            `[RESOURCE_PATH_SYMLINK] resource path cannot traverse a symbolic link: ${filePath}`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    if (!options.allowMissingLeaf && !fs.existsSync(resolved)) {
      throw new Error(`Resource path does not exist: ${resolved}`);
    }
    return resolved;
  },
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  safeMkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    fs.mkdirSync(dirPath, { recursive: options?.recursive !== false }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  loadJson: <T>(filePath: string): T => {
    const schemaPath =
      filePath.includes('notification-preferences.schema.json') ||
      filePath.includes('ops-alert-log-record.schema.json')
        ? path.resolve(
            process.cwd(),
            `knowledge/product/schemas/${
              filePath.includes('ops-alert-log-record.schema.json')
                ? 'ops-alert-log-record.schema.json'
                : 'notification-preferences.schema.json'
            }`
          )
        : filePath;
    return JSON.parse(String(fs.readFileSync(schemaPath, 'utf8'))) as T;
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));
vi.mock('../secure-io.js', () => realFsSecureIo);
vi.mock('../foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: realFsSecureIo.loadJson,
    loadJsonIfPresent: realFsSecureIo.loadJsonIfPresent,
    appendFile: realFsSecureIo.safeAppendFileSync,
    exists: realFsSecureIo.safeExistsSync,
    readFile: (filePath: string) => String(realFsSecureIo.safeReadFile(filePath)),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: realFsSecureIo.safeWriteFile,
  }),
  registerFoundationIo: vi.fn(),
}));
vi.mock('../core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('./surface-coordination-store.js', () => ({ enqueueSurfaceOutboxMessage: enqueue }));

const imessage = vi.hoisted(() => vi.fn());
vi.mock('../imessage-bridge.js', () => ({ sendIMessage: imessage }));

const inbox = vi.hoisted(() => ({
  addInboxEntry: vi.fn(),
  listInboxEntries: vi.fn(() => [] as Array<{ entry_id: string }>),
}));
vi.mock('../deliverable-inbox.js', () => inbox);

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
    // Notification channels come from the channel adapter registry (RS-06).
    for (const rel of [
      'knowledge/product/governance/surface-provider-manifests.json',
      'knowledge/product/schemas/surface-provider-manifests.schema.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(tmpRoot, rel));
    }
    process.env.KYBERION_ROOT = tmpRoot;
    vi.resetModules();
    mod = await import('./operator-notifications.js');
    mod.resetOperatorNotificationRateLimiter();
    enqueue.mockReset();
    imessage.mockReset();
    inbox.addInboxEntry.mockReset();
    inbox.listInboxEntries.mockReset().mockReturnValue([]);
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

  it('delivers to the local inbox surface without any bridge', async () => {
    writePrefs({ default_channel: { surface: 'inbox', target: 'operator' } });
    const sent = await mod.notifyOperator('ops_alert', {
      title: 'scheduler down',
      body: 'chronos heartbeat missing',
      correlation_id: 'OPS-123',
    });
    expect(sent).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(inbox.addInboxEntry).toHaveBeenCalledTimes(1);
    expect(inbox.addInboxEntry.mock.calls[0][0]).toMatchObject({
      entryId: 'INBOX-N-589C74A517D435E3AB6E',
      title: 'scheduler down',
      kind: 'operator_notification',
      status: 'unread',
    });
  });

  it('inbox route dedupes an already-queued notification entry (same correlation → same hashed entry)', async () => {
    writePrefs({ default_channel: { surface: 'inbox', target: 'operator' } });
    inbox.listInboxEntries.mockReturnValue([{ entry_id: 'INBOX-N-589C74A517D435E3AB6E' }]);
    const sent = await mod.notifyOperator('ops_alert', {
      title: 'scheduler down',
      body: 'chronos heartbeat missing',
      correlation_id: 'OPS-123',
    });
    expect(sent).toBe(true);
    expect(inbox.addInboxEntry).not.toHaveBeenCalled();
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

  it('fails closed for malformed persisted preference fields', () => {
    writePrefs({
      default_channel: { surface: 'slack', target: 42 },
    });
    expect(mod.loadNotificationPreferences()).toEqual({});

    expect(() =>
      mod.saveNotificationPreferences({
        default_channel: { surface: 'slack', target: 42 } as never,
      })
    ).toThrow('Invalid notification preferences');
  });

  it('rejects unknown events and channel fields before delivery configuration is saved', () => {
    writePrefs({
      per_event: { unknown_event: { surface: 'slack', target: 'C1' } },
    });
    expect(mod.loadNotificationPreferences()).toEqual({});

    expect(() =>
      mod.saveNotificationPreferences({
        default_channel: { surface: 'slack', target: 'C1' },
        per_event: {
          question: { surface: 'slack', target: 'C1', extra: true } as never,
        },
      })
    ).toThrow('Invalid notification preferences');
  });

  it('does not read or overwrite preferences through a symlink', () => {
    const preferencePath = path.join(
      tmpRoot,
      'knowledge',
      'personal',
      'notification-preferences.json'
    );
    const externalPath = path.join(tmpRoot, 'outside-notification-preferences.json');
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(
      externalPath,
      JSON.stringify({ default_channel: { surface: 'slack', target: 'EXTERNAL' } })
    );
    fs.symlinkSync(externalPath, preferencePath);

    expect(mod.loadNotificationPreferences()).toEqual({});
    expect(() =>
      mod.saveNotificationPreferences({
        default_channel: { surface: 'slack', target: 'SHOULD_NOT_WRITE' },
      })
    ).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(JSON.parse(fs.readFileSync(externalPath, 'utf8')).default_channel.target).toBe(
      'EXTERNAL'
    );
  });
  describe('quiet hours', () => {
    const slack = { surface: 'slack', target: 'C1' } as const;
    const quiet = { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' };
    // 2026-10-01T14:00Z = 23:00 JST (quiet); 2026-10-01T03:00Z = 12:00 JST (awake)
    const night = new Date('2026-10-01T14:00:00.000Z');
    const noon = new Date('2026-10-01T03:00:00.000Z');

    it('wraps midnight and is evaluated in the configured timezone', () => {
      expect(mod.isWithinQuietHours(night, quiet)).toBe(true);
      expect(mod.isWithinQuietHours(new Date('2026-10-01T20:30:00.000Z'), quiet)).toBe(true); // 05:30 JST
      expect(mod.isWithinQuietHours(noon, quiet)).toBe(false);
      // Same instant, different zone: 14:00Z is 14:00 in UTC, awake.
      expect(mod.isWithinQuietHours(night, { ...quiet, timezone: 'UTC' })).toBe(false);
      expect(mod.isWithinQuietHours(night, { start: '09:00', end: '09:00', timezone: 'UTC' })).toBe(
        false
      );
    });

    it('parks non-urgent events in the inbox during quiet hours, but never urgent ones', () => {
      const prefs = { default_channel: slack, quiet_hours: quiet };
      expect(mod.resolveOperatorNotificationRoute('mission_completed', prefs, night)).toEqual({
        surface: 'inbox',
        target: 'quiet-hours',
      });
      expect(mod.resolveOperatorNotificationRoute('mission_completed', prefs, noon)).toEqual(slack);
      // ops_alert (charter tripwires) is urgent by default.
      expect(mod.resolveOperatorNotificationRoute('ops_alert', prefs, night)).toEqual(slack);
      // Urgent list is overridable.
      const custom = { ...prefs, urgent_events: ['approval_required' as const] };
      expect(mod.resolveOperatorNotificationRoute('approval_required', custom, night)).toEqual(
        slack
      );
      expect(mod.resolveOperatorNotificationRoute('ops_alert', custom, night)).toEqual({
        surface: 'inbox',
        target: 'quiet-hours',
      });
    });

    it('never turns mute or "unconfigured" into a delivery', () => {
      const prefs = { per_event: { question: 'mute' as const }, quiet_hours: quiet };
      expect(mod.resolveOperatorNotificationRoute('question', prefs, night)).toBe('mute');
      expect(mod.resolveOperatorNotificationRoute('deliverable_ready', prefs, night)).toBeNull();
    });

    it('round-trips through save/load and rejects malformed windows', () => {
      mod.saveNotificationPreferences({
        default_channel: slack,
        quiet_hours: quiet,
        urgent_events: ['ops_alert', 'question'],
      });
      expect(mod.loadNotificationPreferences()).toMatchObject({
        quiet_hours: quiet,
        urgent_events: ['ops_alert', 'question'],
      });
      for (const bad of [
        { ...quiet, start: '25:00' },
        { ...quiet, timezone: 'Mars/Olympus' },
        { start: '22:00', end: '07:00' },
      ]) {
        expect(() =>
          mod.saveNotificationPreferences({ default_channel: slack, quiet_hours: bad as never })
        ).toThrow('Invalid notification preferences');
      }
      expect(() => mod.saveNotificationPreferences({ urgent_events: ['bogus'] as never })).toThrow(
        'Invalid notification preferences'
      );
    });
  });
});
