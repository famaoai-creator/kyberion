import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFailoverVoiceBridge,
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

  it('fails over to the next bridge when the first one throws', async () => {
    const calls: string[] = [];
    const bridge = buildFailoverVoiceBridge([
      {
        label: 'primary',
        provider: 'codex',
        bridge: {
          name: 'primary',
          runRoleplaySession: async () => {
            calls.push('primary-roleplay');
            throw new Error('primary failed');
          },
          runOneOnOneSession: async () => {
            calls.push('primary-1on1');
            throw new Error('primary failed');
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        bridge: {
          name: 'fallback',
          runRoleplaySession: async (input) => {
            calls.push('fallback-roleplay');
            return { written_to: input.outputPath, _synthetic: true, turns: [] };
          },
          runOneOnOneSession: async (input) => {
            calls.push('fallback-1on1');
            return {
              written_to: input.outputPath,
              person_slug: 'alice',
              visited_at: '2026-07-04T00:00:00.000Z',
              transcript: [],
              stance: 'neutral',
              conditions: [],
              dissent_signals: [],
            };
          },
        },
      },
    ]);

    await expect(
      bridge.runRoleplaySession({
        objective: 'pitch',
        timeBudgetMinutes: 10,
        personaSpec: { style_hints: { tempo: 'fast' } },
        outputPath: '/tmp/session.json',
      })
    ).resolves.toMatchObject({ written_to: '/tmp/session.json' });
    expect(calls).toEqual(['primary-roleplay', 'fallback-roleplay']);
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
