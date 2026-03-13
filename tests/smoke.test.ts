import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/public/orchestration/global_skill_index.json');
const cliScriptPath = path.join(rootDir, 'dist/scripts/cli.js');

describe('Ecosystem Smoke Tests', () => {
  it('has a generated skill index with at least one implemented actuator', () => {
    expect(fs.existsSync(indexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const skills = index.s || index.skills || [];
    const implemented = skills.filter((skill: any) => skill.s === 'implemented' || skill.status === 'implemented');

    expect(Array.isArray(skills)).toBe(true);
    expect(implemented.length).toBeGreaterThan(0);
  });

  it('can render the CLI help output from the built script', () => {
    expect(fs.existsSync(cliScriptPath)).toBe(true);

    const output = execFileSync('node', [cliScriptPath, 'help'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(output).toContain('KYBERION CONSOLE');
    expect(output).toContain('list');
    expect(output).toContain('run');
  });
});
