import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeProject, generateBuildPlan, checkToolchain } from './lib';
import * as fs from 'fs';
import * as fsUtils from '@agent/core/fs-utils';
import * as secureIo from '@agent/core/secure-io';

vi.mock('fs');
vi.mock('@agent/core/fs-utils');
vi.mock('@agent/core/secure-io');

describe('kernel-compiler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('analyzes project structure', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ main: 'index.js', dependencies: { foo: '1.0' } })
    );
    vi.mocked(fsUtils.getAllFiles).mockReturnValue(['index.js', 'lib.ts', 'main.go']);

    const analysis = analyzeProject('.');
    expect(analysis.entryPoints).toContain('index.js');
    expect(analysis.dependencies).toBe(1);
    expect(analysis.languages['.js']).toBe(1);
    expect(analysis.languages['.ts']).toBe(1);
    expect(analysis.languages['.go']).toBe(1);
  });

  it('generates build plan for node', () => {
    const analysis = { entryPoints: ['app.js'], dependencies: 0, scripts: [], languages: {} };
    const plan = generateBuildPlan(analysis, 'node');
    expect(plan.tool).toContain('pkg');
    expect(plan.command).toContain('app.js');
  });

  it('checks toolchain versions', () => {
    vi.mocked(secureIo.safeExec).mockImplementation((cmd) => {
      if (cmd === 'node') return 'v18.0.0';
      if (cmd === 'npm') return '9.0.0';
      return '';
    });

    const toolchain = checkToolchain('node');
    expect(toolchain.node).toBe('v18.0.0');
    expect(toolchain.npm).toBe('9.0.0');
  });
});
