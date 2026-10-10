import { describe, expect, it } from 'vitest';
import {
  agentExecutionContextEnvNames,
  detectAgentExecutionContext,
  isInsideProviderHarness,
  providerHarnessInProcessLineage,
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

describe('providerHarnessInProcessLineage', () => {
  it('finds a provider CLI among the ancestors by binary name', () => {
    expect(
      providerHarnessInProcessLineage(['/bin/zsh', '/Users/a/.local/bin/cursor-agent', '-zsh'])
    ).toBe('cursor-cli');
    expect(providerHarnessInProcessLineage(['zsh', 'claude'])).toBe('claude-cli');
    expect(providerHarnessInProcessLineage(['-codex'])).toBe('codex-cli');
  });

  it('ignores ordinary shells and providers that are not agent harnesses', () => {
    expect(
      providerHarnessInProcessLineage([
        '-zsh',
        'login',
        '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
      ])
    ).toBeNull();
    // `gh` backs the copilot provider but declares no session markers.
    expect(providerHarnessInProcessLineage(['gh'])).toBeNull();
    expect(providerHarnessInProcessLineage(['claude-wrapper'])).toBeNull();
  });

  it('matches full command lines, including interpreter-wrapped provider CLIs', () => {
    expect(
      providerHarnessInProcessLineage([
        '/bin/zsh -c pnpm kyberion approvals --approve x',
        'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js --yolo',
      ])
    ).toBe('codex-cli');
    expect(
      providerHarnessInProcessLineage([
        'node --import ./loader.mjs /home/a/.local/share/cursor-agent/index.js',
      ])
    ).toBe('cursor-cli');
    expect(
      providerHarnessInProcessLineage(['/usr/bin/node --import ./loader.mjs /opt/bin/claude chat'])
    ).toBe('claude-cli');
    expect(providerHarnessInProcessLineage(['bun /opt/tools/cursor-agent'])).toBe('cursor-cli');
    expect(providerHarnessInProcessLineage(['python3 -m codex run'])).toBe('codex-cli');
    // Claude Code runs as `node …/cli.js`: matched by its install path.
    expect(
      providerHarnessInProcessLineage([
        'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --dangerously',
      ])
    ).toBe('claude-cli');
    expect(
      providerHarnessInProcessLineage([
        'node /Users/a/.npm/_npx/6f1c2a/node_modules/@anthropic-ai/claude-code/cli.js',
      ])
    ).toBe('claude-cli');
    expect(providerHarnessInProcessLineage(['/Users/a/.local/share/claude/versions/2.1.0'])).toBe(
      'claude-cli'
    );
    expect(
      providerHarnessInProcessLineage(['node /opt/node_modules/@google/gemini-cli/dist/index.js'])
    ).toBe('gemini-cli');
    // A marker in an argument after the script is not the running program.
    expect(
      providerHarnessInProcessLineage(['node server.js /tmp/@anthropic-ai/claude-code/x'])
    ).toBeNull();
    // A provider name as an ordinary argument is not the running program.
    expect(providerHarnessInProcessLineage(['/usr/bin/git log --author claude'])).toBeNull();
    expect(providerHarnessInProcessLineage(['node server.js claude'])).toBeNull();
  });
});
