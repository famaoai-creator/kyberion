import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core';
import { resolveRecordingPath } from './lib/work-inventory-cli-consent.js';
import { requireDecidedBy, WorkInventoryCliUsageError } from './lib/work-inventory-cli-shared.js';

const SOURCE_FILES = [
  'scripts/work_inventory.ts',
  'scripts/lib/work-inventory-cli-shared.ts',
  'scripts/lib/work-inventory-cli-entries.ts',
  'scripts/lib/work-inventory-cli-harvest.ts',
  'scripts/lib/work-inventory-cli-consent.ts',
  'scripts/lib/work-inventory-cli-promotion.ts',
];

describe('work inventory CLI resource boundaries', () => {
  it('never imports node:fs directly — all I/O goes through the governed core modules', () => {
    for (const relativePath of SOURCE_FILES) {
      const source = readTextFile(pathResolver.rootResolve(relativePath));
      expect(source).not.toContain("from 'node:fs'");
      expect(source).not.toContain('require(');
    }
  });

  it('the dispatcher runs through the shared script harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/work_inventory.ts'));
    expect(source).toMatch(/defineScript\s*\(/);
    expect(source).toContain('isDirectScript');
  });

  it('resolveRecordingPath rejects a path outside the repository root', () => {
    const rootDir = pathResolver.rootDir();
    expect(() => resolveRecordingPath('/etc/passwd', rootDir)).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('resolveRecordingPath rejects a path outside active/shared/runtime/recordings/', () => {
    const rootDir = pathResolver.rootDir();
    expect(() => resolveRecordingPath('active/shared/tmp/not-a-recording.json', rootDir)).toThrow(
      /must be under active\/shared\/runtime\/recordings/
    );
    expect(() =>
      resolveRecordingPath('knowledge/product/governance/cli-commands.json', rootDir)
    ).toThrow(/must be under active\/shared\/runtime\/recordings/);
  });

  it('requireDecidedBy only ever accepts a human user:<member-id> actor', () => {
    expect(() => requireDecidedBy([])).toThrow(WorkInventoryCliUsageError);
    expect(() => requireDecidedBy(['--decided-by', 'not-a-user-id'])).toThrow();
    expect(() => requireDecidedBy(['--decided-by', 'service:automation'])).toThrow();
    expect(requireDecidedBy(['--decided-by', 'user:alice'])).toEqual({
      kind: 'human',
      id: 'user:alice',
    });
  });
});
