import { describe, expect, it, vi } from 'vitest';
import { errorHandler, fileUtils } from './core.js';

// IP-08 Task 5: errorHandler used to process.exit(1) — a failed
// fileUtils.writeJson inside a bridge daemon killed the whole process.
// These tests pin the repaired contract: log, then throw.

describe('errorHandler (IP-08 Task 5)', () => {
  it('throws instead of exiting the process', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    expect(() => errorHandler(new Error('boom'), 'ctx')).toThrow('boom');
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('wraps non-Error values in an Error', () => {
    expect(() => errorHandler('plain string failure')).toThrow('plain string failure');
  });

  it('propagates writeJson failures to the caller instead of killing the host', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    expect(() => fileUtils.writeJson('/nonexistent-root-dir/kyberion/x.json', { a: 1 })).toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
