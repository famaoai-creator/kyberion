import { afterEach, describe, expect, it } from 'vitest';
import {
  getVoiceBridge,
  registerVoiceBridge,
  resetVoiceBridge,
  stubVoiceBridge,
  type VoiceBridge,
} from './voice-bridge.js';

describe('voice-bridge', () => {
  afterEach(() => {
    resetVoiceBridge();
  });

  it('defaults to the stub bridge', () => {
    expect(getVoiceBridge().name).toBe('stub');
  });

  it('resolves a registered bridge', () => {
    const fake: VoiceBridge = {
      name: 'fake',
      runRoleplaySession: stubVoiceBridge.runRoleplaySession,
      runOneOnOneSession: stubVoiceBridge.runOneOnOneSession,
    };
    registerVoiceBridge(fake);
    expect(getVoiceBridge().name).toBe('fake');
  });

  describe('stub bridge', () => {
    it('runs a roleplay session with synthetic turns', async () => {
      const result = await stubVoiceBridge.runRoleplaySession({
        objective: 'pitch',
        timeBudgetMinutes: 10,
        personaSpec: { style_hints: { tempo: 'fast' } },
        outputPath: '/tmp/session.json',
      });
      expect(result._synthetic).toBe(true);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].speaker).toBe('sovereign');
    });

    it('runs a 1on1 session with neutral stance', async () => {
      const result = await stubVoiceBridge.runOneOnOneSession({
        counterpartyRef: 'active/missions/MSN-1/evidence/alice.json',
        proposalDraftRef: 'proposal.md',
        structure: ['context_3min', 'listen_10min', 'soft_ask_2min'],
        outputPath: '/tmp/1on1.json',
      });
      expect(result._synthetic).toBe(true);
      expect(result.person_slug).toBe('alice');
      expect(result.stance).toBe('neutral');
      expect(result.transcript).toEqual([]);
    });
  });
});
