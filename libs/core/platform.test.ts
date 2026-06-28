import { describe, expect, it } from 'vitest';
import { __test__ } from './platform.js';

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
});
