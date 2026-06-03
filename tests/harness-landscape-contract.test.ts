import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

function readJson<T>(relPath: string): T {
  return JSON.parse(read(relPath)) as T;
}

describe('harness landscape contract', () => {
  it('keeps the external landscape report tied to the Kyberion absorption plan', () => {
    const report = read('knowledge/public/external-wisdom/harness-landscape-scan-2026-05.md');
    const plan = read('knowledge/product/architecture/harness-adoption-plan-2026-05.md');
    const bridge = read('knowledge/product/architecture/provider-native-capability-bridge.md');

    expect(report).toContain('OpenClaw');
    expect(report).toContain('Hermes Agent');
    expect(report).toContain('OpenHands Enterprise');
    expect(report).toContain('Claude Cowork');
    expect(report).toContain('Gemini Spark');
    expect(report).toContain('Codex app');
    expect(report).toContain('browser-use');
    expect(report).toContain('skills');
    expect(report).toContain('Kanban');

    expect(plan).toContain('OWASP Top 10:2021');
    expect(plan).toContain('OWASP API Security Top 10');
    expect(plan).toContain('Broken Access Control');
    expect(plan).toContain('Server Side Request Forgery');
    expect(plan).toContain('skill bundles');
    expect(plan).toContain('kanban-style collaboration');
    expect(plan).toContain('provider-native browser and desktop surfaces');

    expect(bridge).toContain('harness-landscape-scan-2026-05.md');
    expect(bridge).toContain('harness-adoption-plan-2026-05.md');
    expect(bridge).toContain('Claude Cowork');
    expect(bridge).toContain('Gemini Spark');
    expect(bridge).toContain('Hermes Kanban');
    expect(bridge).toContain('OpenHands Enterprise');
  });

  it('registers the new provider-runtime surfaces and adapter profiles', () => {
    const capabilityRegistry = readJson<{ capabilities: Array<{ capability_id: string; status: string; fallback_path?: { target?: string } }> }>(
      'knowledge/product/governance/harness-capability-registry.json',
    );
    const adapterRegistry = readJson<{ profiles: Array<{ adapter_id: string; capability_id: string; enabled: boolean }> }>(
      'knowledge/product/governance/harness-adapter-registry.json',
    );

    expect(capabilityRegistry.capabilities.map((item) => item.capability_id)).toEqual(
      expect.arrayContaining([
        'provider.runtime.claude_cowork_desktop',
        'provider.runtime.gemini_spark_desktop',
        'provider.runtime.hermes_kanban_board',
        'provider.runtime.openhands_control_plane',
      ]),
    );

    expect(capabilityRegistry.capabilities.find((item) => item.capability_id === 'provider.runtime.hermes_kanban_board'))
      .toMatchObject({
        status: 'active',
        fallback_path: { target: 'pipelines/a2a-task-contract.json' },
      });

    expect(adapterRegistry.profiles.map((item) => item.adapter_id)).toEqual(
      expect.arrayContaining([
        'claude-cowork.desktop',
        'gemini-spark.desktop',
        'hermes-kanban.board',
        'openhands.control-plane',
      ]),
    );

    expect(adapterRegistry.profiles.find((item) => item.adapter_id === 'openhands.control-plane')).toMatchObject({
      capability_id: 'provider.runtime.openhands_control_plane',
      enabled: true,
    });
  });
});
