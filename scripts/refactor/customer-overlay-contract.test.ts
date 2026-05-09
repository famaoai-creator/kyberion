import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('mission refactor customer overlay contract', () => {
  it('uses the active customer root for mission prerequisites, creation, and llm tools', () => {
    const state = read('scripts/refactor/mission-state.ts');
    const creation = read('scripts/refactor/mission-creation.ts');
    const llm = read('scripts/refactor/mission-llm.ts');

    expect(state).toContain('customerResolver.customerRoot(\'\') ?? pathResolver.knowledge(\'personal\')');
    expect(state).toContain('my-identity.json');
    expect(state).toContain('my-vision.md');
    expect(state).toContain('agent-identity.json');
    expect(creation).toContain('customerResolver.customerRoot(\'my-vision.md\')');
    expect(creation).toContain('profileVisionRef()');
    expect(llm).toContain('customerResolver.customerRoot(\'my-identity.json\')');
  });
});
