import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { loadAgentManifests, resolveSelectionHints } from '@agent/core/agent-manifest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

describe('agent-manifest selection hint loading', () => {
  it('fills provider and model from the agent profile directory selection hints when frontmatter omits them', () => {
    const root = pathResolver.sharedTmp('agent-manifest-fallback-test');
    const agentsDir = `${root}/knowledge/product/agents`;
    const profileDir = `${root}/knowledge/product/orchestration/agent-profiles`;

    safeMkdir(agentsDir, { recursive: true });
    safeMkdir(profileDir, { recursive: true });

    safeWriteFile(
      `${agentsDir}/demo-agent.agent.md`,
      `---\nagentId: demo-agent\ncapabilities: [reasoning, planning]\nauto_spawn: false\ntrust_required: 0\nallowed_actuators: []\n---\n# Demo Agent\n`
    );

    safeWriteFile(
      `${profileDir}/demo-agent.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          agents: {
            'demo-agent': {
              capabilities: ['reasoning', 'planning'],
              authority_roles: [],
              team_roles: [],
              selection_hints: {
                preferred_provider: 'gemini',
                preferred_modelId: 'gemini-2.5-flash',
              },
            },
          },
        },
        null,
        2
      )
    );

    const manifests = loadAgentManifests(root);
    const manifest = manifests.find((entry) => entry.agentId === 'demo-agent');

    expect(manifest).toBeDefined();
    expect(manifest?.selection_hints?.preferred_provider).toBe('gemini');
    expect(manifest?.selection_hints?.preferred_modelId).toBe('gemini-2.5-flash');
    expect(manifest?.capabilities).toEqual(['reasoning', 'planning']);
  });

  it('falls back to the legacy snapshot when the canonical directory is absent', () => {
    const root = pathResolver.sharedTmp('agent-manifest-snapshot-fallback-test');
    const agentsDir = `${root}/knowledge/product/agents`;
    const profileDir = `${root}/knowledge/product/orchestration`;

    safeMkdir(agentsDir, { recursive: true });
    safeMkdir(profileDir, { recursive: true });

    safeWriteFile(
      `${agentsDir}/demo-agent.agent.md`,
      `---\nagentId: demo-agent\ncapabilities: [reasoning, planning]\nauto_spawn: false\ntrust_required: 0\nallowed_actuators: []\n---\n# Demo Agent\n`
    );

    safeWriteFile(
      `${profileDir}/agent-profile-index.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          agents: {
            'demo-agent': {
              capabilities: ['reasoning', 'planning'],
              authority_roles: [],
              team_roles: [],
              selection_hints: {
                preferred_provider: 'gemini',
                preferred_modelId: 'gemini-2.5-flash',
              },
            },
          },
        },
        null,
        2
      )
    );

    const manifests = loadAgentManifests(root);
    const manifest = manifests.find((entry) => entry.agentId === 'demo-agent');

    expect(manifest).toBeDefined();
    expect(manifest?.selection_hints?.preferred_provider).toBe('gemini');
    expect(manifest?.selection_hints?.preferred_modelId).toBe('gemini-2.5-flash');
  });

  it('closes malformed frontmatter values to typed defaults', () => {
    const root = pathResolver.sharedTmp('agent-manifest-malformed-frontmatter-test');
    const agentsDir = `${root}/knowledge/product/agents`;

    safeMkdir(agentsDir, { recursive: true });
    safeWriteFile(
      `${agentsDir}/malformed-agent.agent.md`,
      `---\nagentId: malformed-agent\ncapabilities: [reasoning, 7]\nauto_spawn: yes\ntrust_required: high\nrequires:\n  env: [TOKEN, 8]\n  services: invalid\nallowed_actuators: [browser, false]\n---\n# Malformed Agent\n`
    );

    const manifest = loadAgentManifests(root).find((entry) => entry.agentId === 'malformed-agent');

    expect(manifest).toMatchObject({
      agentId: 'malformed-agent',
      capabilities: ['reasoning'],
      autoSpawn: false,
      trustRequired: 0,
      requires: {
        env: ['TOKEN'],
        services: [],
      },
      allowedActuators: ['browser'],
    });
  });

  it('skips a manifest entry replaced with a directory', () => {
    const root = pathResolver.sharedTmp('agent-manifest-directory-test');
    const agentsDir = `${root}/knowledge/product/agents`;

    try {
      safeMkdir(`${agentsDir}/directory-agent.agent.md`, { recursive: true });
      expect(loadAgentManifests(root)).toEqual([]);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest file reached through a symbolic link', () => {
    const root = pathResolver.sharedTmp('agent-manifest-symlink-test');
    const agentsDir = `${root}/knowledge/product/agents`;
    const target = `${root}/real.agent.md`;
    const linked = `${agentsDir}/linked-agent.agent.md`;

    try {
      safeMkdir(agentsDir, { recursive: true });
      safeWriteFile(
        target,
        '---\nagentId: linked-agent\ncapabilities: []\nauto_spawn: false\ntrust_required: 0\n---\n# Linked\n'
      );
      fs.symlinkSync(target, linked);

      expect(loadAgentManifests(root)).toEqual([]);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves selection hints with an explicit fallback provider', () => {
    const resolved = resolveSelectionHints(
      {
        preferred_modelId: 'gemini-2.5-flash',
      },
      'gemini',
      undefined,
      'demo-agent'
    );

    expect(resolved).toEqual({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });
  });

  it('throws when provider selection hints are missing', () => {
    expect(() => resolveSelectionHints({}, undefined, undefined, 'demo-agent')).toThrow(
      'Missing provider selection hint for agent "demo-agent"'
    );
  });
});
