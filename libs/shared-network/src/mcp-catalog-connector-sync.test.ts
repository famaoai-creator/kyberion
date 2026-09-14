import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import * as path from 'node:path';

describe('mcp catalog ↔ connector sync', () => {
  it('connector expected_tools is a subset of catalog tool names', () => {
    const catalog = JSON.parse(
      readTextFile(pathResolver.knowledge('product/governance/mcp-tool-catalog.json'))
    ) as { tools: Array<{ name: string }> };
    const connector = JSON.parse(
      readTextFile(path.join(pathResolver.rootDir(), 'plugins/kyberion/connector.json'))
    ) as { expected_tools: string[] };

    const catalogNames = new Set(catalog.tools.map((t) => t.name));
    expect(connector.expected_tools.length).toBeGreaterThan(0);
    for (const name of connector.expected_tools) {
      expect(catalogNames.has(name), `missing from catalog: ${name}`).toBe(true);
    }
  });

  it('catalog includes skill transfer and bounded actuator.invoke', () => {
    const catalog = JSON.parse(
      readTextFile(pathResolver.knowledge('product/governance/mcp-tool-catalog.json'))
    ) as {
      tools: Array<{ name: string }>;
      actuator_invoke_allowlist?: unknown[];
    };
    const names = new Set(catalog.tools.map((t) => t.name));
    expect(names.has('kyberion.skill.list')).toBe(true);
    expect(names.has('kyberion.skill.get')).toBe(true);
    expect(names.has('kyberion.actuator.invoke')).toBe(true);
    expect(Array.isArray(catalog.actuator_invoke_allowlist)).toBe(true);
    expect((catalog.actuator_invoke_allowlist || []).length).toBeGreaterThan(0);
  });
});
