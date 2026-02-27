/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMermaidGraph } from './lib';
import * as fs from 'fs';

// Mock fs module
vi.mock('fs');

describe('generateMermaidGraph', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should generate a basic graph with no skills if directory is empty', () => {
    // Mock readdirSync to return empty array
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    const result = generateMermaidGraph('/fake/root');

    expect(result.skillCount).toBe(0);
    expect(result.mermaid).toContain('graph TD');
    expect(result.mermaid).toContain('subgraph Shared_Library');
    expect(result.mermaid).toContain('Lib[libs/core/]');
  });

  it('should include a skill if SKILL.md exists', () => {
    const rootDir = '/fake/root';
    const skillName = 'my-skill';

    // Mock readdirSync to handle recursive calls
    vi.mocked(fs.readdirSync).mockImplementation((dir) => {
      const d = dir.toString();
      if (d === rootDir) return [skillName] as any;
      if (d.includes('scripts')) return ['script.ts'] as any;
      return [] as any;
    });

    // Mock existsSync
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pStr = p.toString();
      // Check if path ends with expected segments
      if (pStr.endsWith(skillName)) return true; // directory exists
      if (pStr.endsWith('SKILL.md')) return true; // SKILL.md exists
      if (pStr.endsWith('scripts')) return true; // scripts dir exists
      if (pStr.endsWith('src')) return false; // src dir does not exist
      return false;
    });

    // Mock statSync to always say it's a directory (for skill folder)
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as any);

    // Mock readFileSync to simulate file content with dependency
    vi.mocked(fs.readFileSync).mockReturnValue("import '@agent/core';");

    const result = generateMermaidGraph(rootDir);

    expect(result.skillCount).toBe(1);
    expect(result.mermaid).toContain('my_skill[my-skill]');
    expect(result.mermaid).toContain('my_skill --> Lib');
  });
});
