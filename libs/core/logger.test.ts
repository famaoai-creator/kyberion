import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  emitConsoleLine,
  flushRepeatMarkers,
  formatDiagnostic,
  resolveLogThreshold,
} from './logger.js';

describe('logger', () => {
  let stderr: string[];
  let stdout: string[];
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stderr = [];
    stdout = [];
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    process.argv = originalArgv.filter((a) => a !== '--quiet' && a !== '--json');
  });

  afterEach(() => {
    flushRepeatMarkers();
    stderr = [];
    stdout = [];
    errSpy.mockRestore();
    outSpy.mockRestore();
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('drops debug lines at the default info threshold', () => {
    const log = createLogger('t');
    log.debug('hidden');
    log.info('shown');
    expect(stderr.join('')).not.toContain('hidden');
    expect(stderr.join('')).toContain('shown');
  });

  it('emits debug lines when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const log = createLogger('t');
    log.debug('visible now');
    expect(stderr.join('')).toContain('visible now');
  });

  it('suppresses non-error output under --quiet', () => {
    process.argv = [...process.argv, '--quiet'];
    const log = createLogger('t');
    log.info('muted');
    log.error('loud');
    expect(stderr.join('')).not.toContain('muted');
    expect(stderr.join('')).toContain('loud');
  });

  it('suppresses everything including errors when LOG_LEVEL=silent', () => {
    process.env.LOG_LEVEL = 'silent';
    const log = createLogger('t');
    log.error('muted error');
    expect(stderr.join('')).toBe('');
  });

  it('compresses consecutive identical info lines into a repeat marker', () => {
    const log = createLogger('t');
    log.info('ready');
    log.info('ready');
    log.info('ready');
    log.info('different');
    const lines = stderr.join('').trim().split('\n');
    expect(lines.filter((l) => l.includes('] ready'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('repeated above ×3'))).toBe(true);
    expect(lines.some((l) => l.includes('different'))).toBe(true);
  });

  it('never compresses warn or error lines', () => {
    const log = createLogger('t');
    log.warn('same warn');
    log.warn('same warn');
    log.error('same error');
    log.error('same error');
    const lines = stderr.join('').trim().split('\n');
    expect(lines.filter((l) => l.includes('same warn'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('same error'))).toHaveLength(2);
    expect(lines.some((l) => l.includes('repeated'))).toBe(false);
  });

  it('flushes a pending repeat marker at streak end', () => {
    emitConsoleLine('stdout', 'alpha', { key: 'a', dedup: true });
    emitConsoleLine('stdout', 'alpha', { key: 'a', dedup: true });
    emitConsoleLine('stdout', 'alpha', { key: 'a', dedup: true });
    emitConsoleLine('stdout', 'beta', { key: 'b', dedup: true });
    const lines = stdout.join('').trim().split('\n');
    expect(lines.filter((l) => l === 'alpha')).toHaveLength(1);
    expect(lines.some((l) => l.includes('repeated'))).toBe(true);
    expect(lines.filter((l) => l === 'beta')).toHaveLength(1);
  });

  it('flushes a pending info streak before an interleaved warn on the same stream', () => {
    const log = createLogger('t');
    log.info('tick');
    log.info('tick');
    log.warn('interruption');
    const lines = stderr.join('').trim().split('\n');
    const tickIdx = lines.findIndex((l) => l.includes('] tick'));
    const markerIdx = lines.findIndex((l) => l.includes('repeated above ×2'));
    const warnIdx = lines.findIndex((l) => l.includes('interruption'));
    expect(tickIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBe(tickIdx + 1);
    expect(warnIdx).toBe(markerIdx + 1);
  });

  it('resolves thresholds from explicit option and env', () => {
    expect(resolveLogThreshold('error')).toBe(3);
    process.env.LOG_LEVEL = 'warn';
    expect(resolveLogThreshold()).toBe(2);
  });

  it('renders diagnostics in the canonical component|what|why|next|evidence form', () => {
    expect(
      formatDiagnostic({
        component: 'operator-notifications',
        what: 'delivery failed for ops_alert',
        why: '[POLICY_VIOLATION] denied',
        next: 'grant inbox write to the persona',
        evidence: 'active/shared/logs/audit/audit-2026-09-30.jsonl',
      })
    ).toBe(
      '[operator-notifications] delivery failed for ops_alert — [POLICY_VIOLATION] denied | next: grant inbox write to the persona | evidence: active/shared/logs/audit/audit-2026-09-30.jsonl'
    );
  });

  it('renders diagnostics with only required fields', () => {
    expect(formatDiagnostic({ component: 'x', what: 'broke' })).toBe('[x] broke');
  });

  it('emits json lines when LOG_FORMAT=json', () => {
    process.env.LOG_FORMAT = 'json';
    const log = createLogger('t');
    log.info('structured', { n: 1 });
    const parsed = JSON.parse(stderr.join('').trim());
    expect(parsed.level).toBe('info');
    expect(parsed.skill).toBe('t');
    expect(parsed.msg).toBe('structured');
    expect(parsed.n).toBe(1);
  });
});
