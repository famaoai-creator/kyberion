import { describe, expect, it } from 'vitest';
import { resolveTeamRoleSelectionHints } from './team-role-selection.js';

describe('team-role selection hints', () => {
  it('normalizes preferred agents and models', () => {
    const resolved = resolveTeamRoleSelectionHints({
      selection_hints: {
        preferred_agents: [' Nerve-Agent ', 'Sovereign-Brain'],
        preferred_models: [' auto-gemini-3 ', 'Gemini-2.5-Flash'],
      },
    });

    expect(resolved).toEqual({
      preferred_agents: ['nerve-agent', 'sovereign-brain'],
      preferred_models: ['auto-gemini-3', 'gemini-2.5-flash'],
    });
  });

  it('returns empty lists when hints are absent', () => {
    expect(resolveTeamRoleSelectionHints({})).toEqual({
      preferred_agents: [],
      preferred_models: [],
    });
  });
});
