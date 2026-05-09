import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from './secure-io.js';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('slack onboarding customer overlay contract', () => {
  it('uses the active customer root for environment initialization and persistence', () => {
    const script = read('libs/core/slack-onboarding.ts');
    expect(script).toContain('customerResolver.customerRoot');
    expect(script).toContain('function profileRoot()');
    expect(script).toContain("path.join(root, 'my-identity.json')");
    expect(script).toContain("path.join(root, 'my-vision.md')");
    expect(script).toContain("path.join(root, 'agent-identity.json')");
  });
});
