import { describe, expect, it } from 'vitest';
import {
  agentExecutionContextEnvNames,
  detectAgentExecutionContext,
  isInsideProviderHarness,
} from './agent-execution-context.js';
import { listCliReasoningProviderDescriptors } from './reasoning/reasoning-provider-registry.js';

describe('detectAgentExecutionContext', () => {
  it('reports a plain terminal as not an agent', () => {
    expect(detectAgentExecutionContext({ env: {} })).toEqual({
      isAgent: false,
      principal: null,
      harnesses: [],
      signals: [],
    });
  });

  it('detects every provider harness marker declared in the registry', () => {
    const descriptors = listCliReasoningProviderDescriptors().filter(
      (descriptor) => (descriptor.cli.session_markers ?? []).length > 0
    );
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      for (const marker of descriptor.cli.session_markers ?? []) {
        const context = detectAgentExecutionContext({
          env: { [marker.env]: marker.equals ?? '1' },
        });
        expect(context.isAgent).toBe(true);
        expect(context.harnesses).toContain(descriptor.mode);
        expect(context.principal).toBe(
          `agent:${descriptor.cli.session_principal ?? descriptor.mode}`
        );
      }
    }
  });

  it('covers the Claude Code, Codex, agy and Cursor markers', () => {
    expect(isInsideProviderHarness('claude-cli', { CLAUDECODE: '1' })).toBe(true);
    expect(isInsideProviderHarness('codex-cli', { CODEX_CLI: '1' })).toBe(true);
    expect(isInsideProviderHarness('codex-cli', { TERM_PROGRAM: 'Codex' })).toBe(true);
    expect(isInsideProviderHarness('agy-cli', { ANTIGRAVITY_CLI: '1' })).toBe(true);
    expect(isInsideProviderHarness('cursor-cli', { CURSOR_AGENT: '1' })).toBe(true);
    expect(isInsideProviderHarness('codex-cli', { TERM_PROGRAM: 'iTerm.app' })).toBe(false);
  });

  it('ignores credentials, binaries and KYBERION_AGENT_* settings that are not markers', () => {
    const context = detectAgentExecutionContext({
      env: {
        CURSOR_API_KEY: 'k',
        ANTHROPIC_API_KEY: 'k',
        KYBERION_CODEX_CLI_BIN: '/usr/local/bin/codex',
        KYBERION_AGENT_RUNTIME_BACKEND: 'pane',
        KYBERION_AGENT_INFLIGHT_LIMIT: '2',
      },
    });
    expect(context.isAgent).toBe(false);
  });

  it('prefers the Kyberion runtime principal and keeps every signal', () => {
    const context = detectAgentExecutionContext({
      env: { KYBERION_AGENT_ID: 'planner', CLAUDECODE: '1', AI_AGENT: 'gemini_cli' },
    });
    expect(context.principal).toBe('agent:planner');
    expect(context.signals.map((signal) => signal.kind)).toEqual([
      'kyberion_runtime',
      'provider_harness',
      'generic_harness',
    ]);
    expect(detectAgentExecutionContext({ env: { KYBERION_RUN_ORIGIN: 'agent' } }).principal).toBe(
      'agent:kyberion-runtime'
    );
    expect(detectAgentExecutionContext({ env: { AI_AGENT: 'gemini_cli' } }).principal).toBe(
      'agent:gemini'
    );
  });

  it('treats an agent-kind authn principal as an agent context', () => {
    const context = detectAgentExecutionContext({
      env: {},
      principal: {
        actor: { kind: 'agent', id: 'kyberion://agent/acme/planner' },
        source: 'agent',
        provider: 'agent-token',
        principalId: 'agent-token:planner',
      },
    });
    expect(context.isAgent).toBe(true);
    expect(context.principal).toBe('kyberion://agent/acme/planner');
    expect(context.signals).toEqual([
      { kind: 'agent_principal', source: 'agent', provider: 'agent-token' },
    ]);
    expect(
      detectAgentExecutionContext({
        env: {},
        principal: {
          actor: { kind: 'human', id: 'user:owner' },
          source: 'loopback',
          provider: 'loopback-local',
          principalId: 'user:owner',
        },
      }).isAgent
    ).toBe(false);
  });

  it('lists every env name it reads', () => {
    const names = agentExecutionContextEnvNames();
    for (const name of [
      'KYBERION_AGENT_ID',
      'KYBERION_NHI_ID',
      'KYBERION_RUN_ORIGIN',
      'CLAUDECODE',
      'CODEX_CLI',
      'AGY_CLI',
      'CURSOR_AGENT',
      'AI_AGENT',
    ]) {
      expect(names).toContain(name);
    }
  });
});
