import { describe, it, expect } from 'vitest';
import { __test__, currentPlatform, hasBuiltInTts } from './native-tts.js';

describe('native-tts', () => {
  describe('buildCommand', () => {
    it('builds a darwin say command with no voice/rate', () => {
      // Test by simulating the platform branch via the exported helper, regardless of host.
      // We rely on the actual PLATFORM constant for behavior here; on non-darwin hosts
      // these will exercise the host's branch.
      const result = __test__.buildCommand('hello', {});
      expect(result).not.toBeNull();
      expect(result!.cmd).toBeTruthy();
      expect(result!.args.length).toBeGreaterThan(0);
    });

    it('strips control characters from text', () => {
      const dangerous = 'hello\x00world\x07';
      const result = __test__.buildCommand(dangerous, {});
      expect(result).not.toBeNull();
      // Last arg on macOS/Linux is the text; on Windows it's the PowerShell command containing the text.
      const lastArg = result!.args[result!.args.length - 1];
      expect(lastArg).not.toContain('\x00');
      expect(lastArg).not.toContain('\x07');
    });

    it('includes voice flag when provided (host-dependent shape)', () => {
      const result = __test__.buildCommand('hi', { voice: 'Alex' });
      expect(result).not.toBeNull();
      // The voice flag is stringified somewhere in the args.
      expect(result!.args.some(a => a === 'Alex' || a.includes('Alex'))).toBe(true);
    });
  });

  describe('platform helpers', () => {
    it('reports a known platform', () => {
      expect(['darwin', 'linux', 'win32']).toContain(currentPlatform());
    });

    it('hasBuiltInTts is true on darwin / win32', () => {
      const p = currentPlatform();
      if (p === 'darwin' || p === 'win32') {
        expect(hasBuiltInTts()).toBe(true);
      } else {
        expect(hasBuiltInTts()).toBe(false);
      }
    });
  });
});
