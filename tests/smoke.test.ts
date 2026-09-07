import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core';
import { main as runCli } from '../scripts/cli.js';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/product/orchestration/global_actuator_index.json');
const cliScriptPath = path.join(rootDir, 'dist/scripts/cli.js');

describe('Ecosystem Smoke Tests', () => {
  it('has a generated actuator index with at least one implemented actuator', () => {
    expect(safeExistsSync(indexPath)).toBe(true);

    const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
    const actuators = index.actuators || index.s || index.skills || [];
    const implemented = actuators.filter(
      (actuator: any) => actuator.s === 'implemented' || actuator.status === 'implemented'
    );

    expect(Array.isArray(actuators)).toBe(true);
    expect(implemented.length).toBeGreaterThan(0);
  });

  it('can render the CLI help output', async () => {
    expect(safeExistsSync(cliScriptPath)).toBe(true);

    // main() now routes output through an explicit print sink (SX-05
    // governed-printer pass) rather than calling console.log directly, so
    // help text must be captured through that sink.
    const output: string[] = [];
    await runCli(['help'], (value) => output.push(String(value)));

    const rendered = output.join('\n');
    expect(rendered).toContain('KYBERION CONSOLE');
    expect(rendered).toContain('list');
    expect(rendered).toContain('run');
  });
});
