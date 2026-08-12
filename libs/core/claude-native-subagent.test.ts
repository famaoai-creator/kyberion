import { describe, expect, it } from 'vitest';
import {
  buildClaudeNativeAgentDefinitions,
  buildClaudeNativeDelegationPrompt,
  claudeNativeAgentName,
  resolveClaudeNativeSessionPermission,
} from './claude-native-subagent.js';
import { SUBAGENT_PROFILE_CLI_TOOLS } from './subagent-capability-profiles.js';
import { SUBAGENT_SECURE_IO_CONSTRAINT } from './subagent-prompt-framing.js';

describe('claude native subagent projection (CN-02)', () => {
  it('projects the implementer tier onto bypassPermissions and its full CLI tool set', () => {
    const permission = resolveClaudeNativeSessionPermission('implementer');

    expect(permission.permissionMode).toBe('bypassPermissions');
    expect(permission.disallowedTools).toEqual([]);
    expect(permission.agentTools).toEqual(SUBAGENT_PROFILE_CLI_TOOLS.implementer);
  });

  it('narrows the explorer tier to the intersection of KD-05 and the permission matrix', () => {
    const permission = resolveClaudeNativeSessionPermission('explorer');

    expect(permission.permissionMode).toBe('default');
    // KD-05 grants NotebookRead, the XP-02 allowlist does not — least agency wins.
    expect(permission.agentTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(permission.disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'Bash', 'NotebookEdit'])
    );
    for (const denied of permission.disallowedTools) {
      expect(permission.agentTools).not.toContain(denied);
    }
  });

  it('projects the planner tier onto plan mode with no tools at all', () => {
    const permission = resolveClaudeNativeSessionPermission('planner');

    expect(permission.permissionMode).toBe('plan');
    expect(permission.agentTools).toEqual([]);
  });

  it('builds an agent definition carrying the KD-05 framing and secure-io constraint', () => {
    const definitions = buildClaudeNativeAgentDefinitions('explorer');
    const definition = definitions[claudeNativeAgentName('explorer')];

    expect(definition).toBeDefined();
    expect(definition.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(definition.prompt).toContain('You are a delegated explorer sub-agent.');
    expect(definition.prompt).toContain(SUBAGENT_SECURE_IO_CONSTRAINT);
    expect(definition.prompt).toContain('Working principles');
    expect(definition.prompt).toContain('Shared-directory rules');
  });

  it('demands a foreground delegation so the sub-agent report is the turn result', () => {
    const prompt = buildClaudeNativeDelegationPrompt({
      profileName: 'implementer',
      instruction: 'fix the failing test',
      context: 'mission ctx',
    });

    expect(prompt).toContain('subagent_type: "kyberion-implementer"');
    expect(prompt).toContain('run_in_background: false');
    expect(prompt).toContain('Context:\nmission ctx');
    expect(prompt).toContain('Task: fix the failing test');
  });
});
