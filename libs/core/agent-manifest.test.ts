import { describe, expect, it } from 'vitest';
import { loadAgentManifests, resolveSelectionHints, safeMkdir, safeWriteFile, pathResolver } from '@agent/core';

describe('agent-manifest selection hint loading', () => {
  it('fills provider and model from the agent profile index selection hints when frontmatter omits them', () => {
    const root = pathResolver.sharedTmp('agent-manifest-fallback-test');
    const agentsDir = `${root}/knowledge/agents`;
    const profileDir = `${root}/knowledge/public/orchestration`;

    safeMkdir(agentsDir, { recursive: true });
    safeMkdir(profileDir, { recursive: true });

    safeWriteFile(
      `${agentsDir}/demo-agent.agent.md`,
      `---\nagentId: demo-agent\ncapabilities: [reasoning, planning]\nauto_spawn: false\ntrust_required: 0\nallowed_actuators: []\n---\n# Demo Agent\n`,
    );

    safeWriteFile(
      `${profileDir}/agent-profile-index.json`,
      JSON.stringify({
        version: '1.0.0',
        agents: {
          'demo-agent': {
            capabilities: ['reasoning', 'planning'],
            selection_hints: {
              preferred_provider: 'gemini',
              preferred_modelId: 'gemini-2.5-flash',
            },
          },
        },
      }, null, 2),
    );

    const manifests = loadAgentManifests(root);
    const manifest = manifests.find((entry) => entry.agentId === 'demo-agent');

    expect(manifest).toBeDefined();
    expect(manifest?.selection_hints?.preferred_provider).toBe('gemini');
    expect(manifest?.selection_hints?.preferred_modelId).toBe('gemini-2.5-flash');
    expect(manifest?.capabilities).toEqual(['reasoning', 'planning']);
  });

  it('resolves selection hints with an explicit fallback provider', () => {
    const resolved = resolveSelectionHints(
      {
        preferred_modelId: 'gemini-2.5-flash',
      },
      'gemini',
      undefined,
      'demo-agent',
    );

    expect(resolved).toEqual({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });
  });

  it('throws when provider selection hints are missing', () => {
    expect(() => resolveSelectionHints({}, undefined, undefined, 'demo-agent')).toThrow(
      'Missing provider selection hint for agent "demo-agent"',
    );
  });
});
