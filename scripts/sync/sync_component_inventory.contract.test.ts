import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { renderComponentInventory } from './sync_component_inventory.js';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('component inventory generator boundary', () => {
  it('keeps generated Markdown stable under the commit formatter', async () => {
    const generated = await renderComponentInventory();
    const markdown = generated.filter((file) => file.path.endsWith('.md'));
    expect(markdown).toHaveLength(2);
    for (const file of markdown) {
      expect(
        await prettierFormat(file.content, {
          ...((await resolvePrettierConfig(file.path)) ?? {}),
          filepath: file.path,
        })
      ).toBe(file.content);
    }
  });
  it('uses the shared generator harness for every declared artifact', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync/sync_component_inventory.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('defineGenerator');
    expect(source).toContain('runSyncComponentInventory');
    expect(source).toContain('CURRENT_INDEX_PATH');
    expect(source).toContain('SKILL_INDEX_PATH');
    expect(source).toContain('LEGACY_INDEX_PATH');
    expect(source).toContain('REPORT_PATH');
    expect(source).toContain('CAPABILITIES_GUIDE_PATH');
    expect(source).toContain('parseSafeJsonObjectInput');
    expect(source).toContain('loadActuatorManifest');
    expect(source).not.toContain('interface CapabilityManifest');
    expect(source).not.toContain('readJson<CapabilityManifest>');
    expect(source).not.toContain('JSON.parse(withoutGeneratedDate)');
    expect(source).not.toContain('withExecutionContext');
    expect(source).not.toContain('safeWriteFile');
  });
});
