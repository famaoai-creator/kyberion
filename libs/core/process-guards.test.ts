import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessGuards, resetProcessGuardsForTests } from './process-guards.js';
import { logger } from './core.js';

// IP-08 Task 6: recording guards for long-lived processes.
describe('installProcessGuards', () => {
  afterEach(() => {
    resetProcessGuardsForTests();
    vi.restoreAllMocks();
  });

  it('logs unhandled rejections without exiting the process', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const onSpy = vi.spyOn(process, 'on');
    try {
      installProcessGuards('test-server');
      const rejectionHandler = onSpy.mock.calls.find(
        (call) => call[0] === 'unhandledRejection'
      )?.[1] as (reason: unknown) => void;
      const exceptionHandler = onSpy.mock.calls.find(
        (call) => call[0] === 'uncaughtException'
      )?.[1] as (error: unknown) => void;

      expect(rejectionHandler).toBeDefined();
      expect(exceptionHandler).toBeDefined();

      rejectionHandler(new Error('floaty'));
      exceptionHandler(new Error('boom'));

      const logged = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => line.includes('[test-server] unhandledRejection'))).toBe(true);
      expect(logged.some((line) => line.includes('[test-server] uncaughtException'))).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      // detach the real listeners we just registered
      process.removeAllListeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
    }
  });

  it('is idempotent — second install does not duplicate listeners', () => {
    try {
      installProcessGuards('server-a');
      const before = process.listenerCount('unhandledRejection');
      installProcessGuards('server-a');
      installProcessGuards('server-b');
      expect(process.listenerCount('unhandledRejection')).toBe(before);
    } finally {
      process.removeAllListeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
    }
  });
});
