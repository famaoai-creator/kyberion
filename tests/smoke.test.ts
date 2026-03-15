import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/public/orchestration/global_skill_index.json');
const cliScriptPath = path.join(rootDir, 'dist/scripts/cli.js');

describe('Ecosystem Smoke Tests', () => {
  it('has a generated skill index with at least one implemented actuator', () => {
    expect(safeExistsSync(indexPath)).toBe(true);

    const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
    const skills = index.s || index.skills || [];
    const implemented = skills.filter((skill: any) => skill.s === 'implemented' || skill.status === 'implemented');

    expect(Array.isArray(skills)).toBe(true);
    expect(implemented.length).toBeGreaterThan(0);
  });

  it('can render the CLI help output from the built script', () => {
    expect(safeExistsSync(cliScriptPath)).toBe(true);

    const output = execFileSync('node', ['--import', 'tsx', 'scripts/cli.ts', 'help'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(output).toContain('KYBERION CONSOLE');
    expect(output).toContain('list');
    expect(output).toContain('run');
  });
});
