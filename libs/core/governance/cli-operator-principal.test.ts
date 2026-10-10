import { describe, expect, it } from 'vitest';
import { listCliReasoningProviderDescriptors } from '../reasoning/reasoning-provider-registry.js';
import { cliAgentSessionEnv, detectCliAgentPrincipal } from './cli-operator-principal.js';

/**
 * Agent-session detection reads the provider CLI harness markers from the
 * reasoning-provider registry (`cli.session_markers` / `cli.session_principal`),
 * not from a list kept in this module.
 */
describe('detectCliAgentPrincipal', () => {
  it('derives every harness marker from the reasoning-provider registry', () => {
    const declared = listCliReasoningProviderDescriptors().flatMap((descriptor) =>
      (descriptor.cli.session_markers ?? []).map((marker) => marker.env)
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(cliAgentSessionEnv()).toEqual(expect.arrayContaining([...new Set(declared)]));
    expect(cliAgentSessionEnv()).toEqual(
      expect.arrayContaining([
        'KYBERION_AGENT_ID',
        'KYBERION_NHI_ID',
        'KYBERION_RUN_ORIGIN',
        'AI_AGENT',
      ])
    );
  });

  it('records each declared harness as agent:<session_principal or mode>', () => {
    for (const descriptor of listCliReasoningProviderDescriptors()) {
      for (const marker of descriptor.cli.session_markers ?? []) {
        expect(detectCliAgentPrincipal({ [marker.env]: marker.equals ?? '1' })).toBe(
          `agent:${descriptor.cli.session_principal ?? descriptor.mode}`
        );
      }
    }
    expect(detectCliAgentPrincipal({ CLAUDECODE: '1' })).toBe('agent:claude-code');
    expect(detectCliAgentPrincipal({ TERM_PROGRAM: 'Codex' })).toBe('agent:codex-cli');
  });

  it('ignores credentials and binaries in env_keys and non-matching values', () => {
    expect(detectCliAgentPrincipal({})).toBeNull();
    expect(detectCliAgentPrincipal({ CURSOR_API_KEY: 'k', GH_TOKEN: 't' })).toBeNull();
    expect(detectCliAgentPrincipal({ TERM_PROGRAM: 'iTerm.app' })).toBeNull();
  });

  it('prefers the Kyberion runtime signals over harness markers', () => {
    expect(detectCliAgentPrincipal({ KYBERION_AGENT_ID: 'planner', CLAUDECODE: '1' })).toBe(
      'agent:planner'
    );
    expect(detectCliAgentPrincipal({ KYBERION_RUN_ORIGIN: 'agent' })).toBe(
      'agent:kyberion-runtime'
    );
  });
});
