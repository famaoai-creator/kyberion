import { describe, expect, it } from 'vitest';
import { __test__, isAppleSilicon, isLinux, isMacOS, isWindows } from './platform.js';

describe('platform', () => {
  describe('buildMacSpeakArgs', () => {
    it('places voice and rate flags before the text payload', () => {
      expect(__test__.buildMacSpeakArgs('hello', { voice: 'Kyoko', rate: 180 })).toEqual([
        '-v',
        'Kyoko',
        '-r',
        '180',
        'hello',
      ]);
    });

    it('omits optional flags when not provided', () => {
      expect(__test__.buildMacSpeakArgs('hello')).toEqual(['hello']);
    });
  });

  describe('OS predicates (hermetic — injected params, never host values)', () => {
    it('isMacOS matches darwin only', () => {
      expect(isMacOS('darwin')).toBe(true);
      expect(isMacOS('win32')).toBe(false);
      expect(isMacOS('linux')).toBe(false);
    });

    it('isWindows matches win32 only', () => {
      expect(isWindows('win32')).toBe(true);
      expect(isWindows('darwin')).toBe(false);
      expect(isWindows('linux')).toBe(false);
    });

    it('isLinux matches linux only', () => {
      expect(isLinux('linux')).toBe(true);
      expect(isLinux('darwin')).toBe(false);
      expect(isLinux('win32')).toBe(false);
    });

    it('isAppleSilicon requires darwin + arm64', () => {
      expect(isAppleSilicon('darwin', 'arm64')).toBe(true);
      expect(isAppleSilicon('darwin', 'x64')).toBe(false);
      expect(isAppleSilicon('linux', 'arm64')).toBe(false);
      expect(isAppleSilicon('win32', 'arm64')).toBe(false);
    });
  });
});
