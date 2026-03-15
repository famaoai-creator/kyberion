import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '../libs/core/index.js';
import { main as runCli } from '../scripts/cli.js';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/public/orchestration/global_actuator_index.json');
const cliScriptPath = path.join(rootDir, 'dist/scripts/cli.js');

describe('Ecosystem Smoke Tests', () => {
  it('has a generated actuator index with at least one implemented actuator', () => {
    expect(safeExistsSync(indexPath)).toBe(true);

    const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
    const actuators = index.actuators || index.s || index.skills || [];
    const implemented = actuators.filter((actuator: any) => actuator.s === 'implemented' || actuator.status === 'implemented');

    expect(Array.isArray(actuators)).toBe(true);
    expect(implemented.length).toBeGreaterThan(0);
  });

  it('can render the CLI help output', async () => {
    expect(safeExistsSync(cliScriptPath)).toBe(true);

    const output: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });

    try {
      await runCli(['help']);
    } finally {
      logSpy.mockRestore();
    }

    const rendered = output.join('\n');
    expect(rendered).toContain('KYBERION CONSOLE');
    expect(rendered).toContain('list');
    expect(rendered).toContain('run');
  });
});
