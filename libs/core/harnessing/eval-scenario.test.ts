import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { loadProbeScenario } from './eval-scenario.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-scenario-test');

function workspace(): string {
  const dir = path.join(ROOT, 'ws');
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'run.sh'), '#!/bin/sh\necho ok > out.txt\n');
  return dir;
}

function specFile(name: string, spec: unknown): string {
  const dir = path.join(ROOT, 'specs');
  safeMkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  safeWriteFile(file, JSON.stringify(spec));
  return file;
}

describe('loadProbeScenario', () => {
  it('loads a valid spec into ProbeSpec-ready shape', () => {
    const ws = workspace();
    const file = specFile('ok', {
      name: 'ok-scenario',
      workspace_dir: ws,
      command: ['sh', 'run.sh'],
      expect_outputs: ['out.txt'],
      description: 'a wrapped fixture',
    });
    const s = loadProbeScenario(file);
    expect(s.name).toBe('ok-scenario');
    expect(s.scenarioDir).toBe(ws);
    expect(s.command).toEqual(['sh', 'run.sh']);
    expect(s.expectOutputs).toEqual(['out.txt']);
    expect(s.description).toBe('a wrapped fixture');
  });

  it('rejects a missing workspace_dir', () => {
    const file = specFile('nows', {
      name: 'nows',
      workspace_dir: path.join(ROOT, 'no-such-ws'),
      command: ['sh', 'run.sh'],
    });
    expect(() => loadProbeScenario(file)).toThrow(/\[EVAL_SCENARIO\]/);
  });

  it('rejects a traversal expect_outputs path', () => {
    const file = specFile('traversal', {
      name: 'trav',
      workspace_dir: workspace(),
      command: ['sh', 'run.sh'],
      expect_outputs: ['../escape.txt'],
    });
    expect(() => loadProbeScenario(file)).toThrow(/expect_outputs/);
  });

  it('rejects a non-argv command', () => {
    const asString = specFile('strcmd', {
      name: 's',
      workspace_dir: workspace(),
      command: 'sh run.sh',
    });
    expect(() => loadProbeScenario(asString)).toThrow(/argv/);
    const empty = specFile('emptycmd', {
      name: 'e',
      workspace_dir: workspace(),
      command: [],
    });
    expect(() => loadProbeScenario(empty)).toThrow(/non-empty/);
    const withBlank = specFile('blankcmd', {
      name: 'b',
      workspace_dir: workspace(),
      command: ['sh', ' '],
    });
    expect(() => loadProbeScenario(withBlank)).toThrow(/argv/);
  });
});
