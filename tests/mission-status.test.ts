import { describe, it, expect } from 'vitest';
import { isValidTransition, transitionStatus } from '@agent/core';
import type { MissionStatus } from '@agent/core';

describe('Mission Status Transition Guard', () => {
  describe('isValidTransition', () => {
    const validCases: [MissionStatus, MissionStatus][] = [
      ['planned', 'active'],
      ['active', 'validating'],
      ['active', 'distilling'],
      ['active', 'paused'],
      ['active', 'failed'],
      ['validating', 'distilling'],
      ['validating', 'active'],
      ['distilling', 'completed'],
      ['paused', 'active'],
      ['failed', 'active'],
      ['completed', 'archived'],
    ];

    for (const [from, to] of validCases) {
      it(`allows ${from} → ${to}`, () => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    }

    const invalidCases: [MissionStatus, MissionStatus][] = [
      ['planned', 'completed'],
      ['planned', 'archived'],
      ['active', 'archived'],
      ['completed', 'active'],
      ['archived', 'active'],
      ['distilling', 'active'],
      ['paused', 'completed'],
    ];

    for (const [from, to] of invalidCases) {
      it(`blocks ${from} → ${to}`, () => {
        expect(isValidTransition(from, to)).toBe(false);
      });
    }
  });

  describe('transitionStatus', () => {
    it('returns target on valid transition', () => {
      expect(transitionStatus('planned', 'active')).toBe('active');
      expect(transitionStatus('distilling', 'completed')).toBe('completed');
    });

    it('throws on invalid transition', () => {
      expect(() => transitionStatus('planned', 'completed')).toThrow('Invalid mission status transition');
      expect(() => transitionStatus('archived', 'active')).toThrow('Invalid mission status transition');
    });

    it('error message includes allowed transitions', () => {
      try {
        transitionStatus('planned', 'archived');
      } catch (e: any) {
        expect(e.message).toContain('active');
        expect(e.message).toContain('planned');
      }
    });
  });
});
