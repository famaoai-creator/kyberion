import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeUnlink: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeAppendFileSync: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);

describe('reasoning-failover marker + event log (XP-05)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reasoning-failover-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('round-trips mark → read → clear without disturbing reasoning-degraded semantics', async () => {
    const { markReasoningFailover, readReasoningFailover, clearReasoningFailover } =
      await import('./reasoning-failover.js');

    expect(readReasoningFailover()).toBeNull();

    markReasoningFailover({
      from_mode: 'claude-agent',
      to_mode: 'codex-cli',
      provider_from: 'claude',
      provider_to: 'codex',
      method: 'delegateTask',
    });
    const marker = readReasoningFailover();
    expect(marker).not.toBeNull();
    expect(marker!.from_mode).toBe('claude-agent');
    expect(marker!.to_mode).toBe('codex-cli');
    expect(Date.parse(marker!.at)).not.toBeNaN();

    clearReasoningFailover();
    expect(readReasoningFailover()).toBeNull();
  });

  it('treats a corrupt marker file as absent', async () => {
    const { readReasoningFailover, reasoningFailoverMarkerPath } =
      await import('./reasoning-failover.js');
    const markerPath = reasoningFailoverMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'not-json');
    expect(readReasoningFailover()).toBeNull();
  });

  it('appends a JSONL event with from/to, method, and a truncated error summary', async () => {
    const { appendReasoningFailoverEvent, reasoningFailoverEventsPath, truncateErrorSummary } =
      await import('./reasoning-failover.js');

    const longError = 'x'.repeat(500);
    appendReasoningFailoverEvent({
      from_mode: 'claude-agent',
      to_mode: 'codex-cli',
      provider_from: 'claude',
      provider_to: 'codex',
      method: 'delegateTask',
      error_summary: longError,
    });

    const eventsPath = reasoningFailoverEventsPath();
    const lines = fs
      .readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event.from_mode).toBe('claude-agent');
    expect(event.to_mode).toBe('codex-cli');
    expect(event.method).toBe('delegateTask');
    expect(event.error_summary).toBe(truncateErrorSummary(longError));
    expect(event.error_summary.length).toBeLessThanOrEqual(201);
    expect(Date.parse(event.ts)).not.toBeNaN();
  });

  it('appends multiple events across separate switches', async () => {
    const { appendReasoningFailoverEvent, reasoningFailoverEventsPath } =
      await import('./reasoning-failover.js');

    appendReasoningFailoverEvent({
      from_mode: 'claude-agent',
      to_mode: 'codex-cli',
      method: 'delegateTask',
      error_summary: 'first failure',
    });
    appendReasoningFailoverEvent({
      from_mode: 'claude-agent',
      to_mode: 'codex-cli',
      method: 'prompt',
      error_summary: 'second failure',
    });

    const lines = fs
      .readFileSync(reasoningFailoverEventsPath(), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
  });
});
