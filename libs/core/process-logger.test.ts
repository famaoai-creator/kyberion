import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let logsProcessDir: string;

vi.mock('./path-resolver.js', () => ({
  sharedLogsProcess: (sub = '') => path.join(logsProcessDir, sub),
}));

vi.mock('./secure-io.js', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeAppendFileSync: (p: string, data: string) => actualFs.appendFileSync(p, data),
    safeExistsSync: (p: string) => actualFs.existsSync(p),
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeStat: (p: string) => actualFs.statSync(p),
    safeMoveSync: (src: string, dest: string) => actualFs.renameSync(src, dest),
  };
});

import { ProcessLogger, createProcessLogger, resetProcessLoggerRegistry } from './process-logger.js';

describe('ProcessLogger', () => {
  beforeEach(() => {
    logsProcessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-proclog-'));
  });

  afterEach(() => {
    fs.rmSync(logsProcessDir, { recursive: true, force: true });
    resetProcessLoggerRegistry();
  });

  it('writes info entries as JSONL', () => {
    const log = new ProcessLogger('test-daemon');
    log.info('started');
    log.info('ready', { port: 3000 });

    const logPath = path.join(logsProcessDir, 'test-daemon.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('started');
    expect(entry.name).toBe('test-daemon');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes meta when provided', () => {
    const log = new ProcessLogger('meta-daemon');
    log.error('crash', { code: 137, reason: 'OOM' });

    const lines = fs.readFileSync(path.join(logsProcessDir, 'meta-daemon.log'), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.meta).toEqual({ code: 137, reason: 'OOM' });
  });

  it('respects minLevel — does not write below threshold', () => {
    const log = new ProcessLogger('quiet-daemon', { minLevel: 'warn' });
    log.debug('trace stuff');
    log.info('info stuff');
    log.warn('warn stuff');
    log.error('error stuff');

    const logPath = path.join(logsProcessDir, 'quiet-daemon.log');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });

  it('rotates when file exceeds maxSizeBytes', () => {
    const log = new ProcessLogger('rotating-daemon', { maxSizeBytes: 100, maxRotations: 3 });
    // Write enough to exceed 100 bytes
    for (let i = 0; i < 5; i++) {
      log.info(`line ${i} — padding to exceed the size threshold`);
    }

    const logPath = path.join(logsProcessDir, 'rotating-daemon.log');
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  });

  it('createProcessLogger returns the same instance for same name', () => {
    const a = createProcessLogger('shared-daemon');
    const b = createProcessLogger('shared-daemon');
    expect(a).toBe(b);
  });

  it('createProcessLogger returns different instances for different names', () => {
    const a = createProcessLogger('daemon-a');
    const b = createProcessLogger('daemon-b');
    expect(a).not.toBe(b);
  });

  it('does not throw when directory creation fails gracefully', () => {
    // Even if writes fail, logger should not propagate errors
    const log = new ProcessLogger('safe-daemon');
    expect(() => log.info('silent failure test')).not.toThrow();
  });
});
