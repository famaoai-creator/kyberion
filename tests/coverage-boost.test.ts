import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, runSkill } from '@agent/core';

describe('Coverage Boost: Core UI & Logic', () => {
  let logSpy: any;
  let errorSpy: any;
  let exitSpy: any;

  beforeEach(() => {
    // The shared logger engine writes via process streams (not console.*),
    // while runSkill still emits result payloads via console.log — funnel both
    // into one recording fn so assertions see a single merged call list.
    logSpy = vi.fn();
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logSpy(...a));
    vi.spyOn(process.stdout, 'write').mockImplementation((...a: unknown[]) => {
      logSpy(...a);
      return true;
    });
    errorSpy = vi.fn();
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errorSpy(...a));
    vi.spyOn(process.stderr, 'write').mockImplementation((...a: unknown[]) => {
      errorSpy(...a);
      return true;
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => undefined as never);
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stripAnsi = (str: string) =>
    str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  describe('Logger', () => {
    it('should format logs correctly in success mode', () => {
      logger.success('Operation completed');
      // Every log level goes to stderr so stdout stays reserved for command output.
      const calls = errorSpy.mock.calls.map((c) => stripAnsi(c[0])).join('\n');
      expect(calls).toContain('[SUCCESS] Operation completed');
    });

    it('should format logs correctly in error mode', () => {
      logger.error('Something went wrong');
      const calls = errorSpy.mock.calls.map((c) => stripAnsi(c[0])).join('\n');
      expect(calls).toContain('[ERROR] Something went wrong');
    });
  });

  describe('Skill Wrapper', () => {
    it('should provide human-readable output when --format=human is present', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'test', '--format=human'];
      process.env.KYBERION_FORMAT = 'human';

      runSkill('test-human', () => ({ message: 'Done' }));

      const allLogs = logSpy.mock.calls.map((c) => stripAnsi(c[0])).join('\n');
      expect(allLogs).toContain('✅ test-human success');
      expect(allLogs).toContain('Done');

      process.argv = originalArgv;
    });

    it('should produce JSON output by default', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'test'];
      process.env.KYBERION_FORMAT = 'json';

      runSkill('test-json', () => ({ ok: true }));

      expect(logSpy).toHaveBeenCalled();
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
      const parsed = JSON.parse(lastCall);
      expect(parsed.skill).toBe('test-json');
      expect(parsed.status).toBe('success');

      process.argv = originalArgv;
    });
  });
});
