import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, runSkill } from '../libs/core/index.js';

describe('Coverage Boost: Core UI & Logic', () => {
  let logSpy: any;
  let errorSpy: any;
  let exitSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => undefined as never);
    process.env.NODE_ENV = 'production'; 
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stripAnsi = (str: string) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  describe('Logger', () => {
    it('should format logs correctly in success mode', () => {
      logger.success('Operation completed');
      const calls = logSpy.mock.calls.map(c => stripAnsi(c[0])).join('\n');
      expect(calls).toContain('[SUCCESS] Operation completed');
    });

    it('should format logs correctly in error mode', () => {
      logger.error('Something went wrong');
      const calls = errorSpy.mock.calls.map(c => stripAnsi(c[0])).join('\n');
      expect(calls).toContain('[ERROR] Something went wrong');
    });
  });

  describe('Skill Wrapper', () => {
    it('should provide human-readable output when --format=human is present', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'test', '--format=human'];
      process.env.KYBERION_FORMAT = 'human';
      
      runSkill('test-human', () => ({ message: 'Done' }));
      
      const allLogs = logSpy.mock.calls.map(c => stripAnsi(c[0])).join('\n');
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
