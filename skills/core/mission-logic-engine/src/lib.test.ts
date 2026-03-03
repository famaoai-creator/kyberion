import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestrate } from './lib';
import * as fs from 'node:fs';
import * as pathResolver from '@agent/core/path-resolver';
import { execSync } from 'node:child_process';
import { safeReadFile } from '@agent/core/secure-io';

vi.mock('node:fs');
vi.mock('@agent/core/path-resolver');
vi.mock('node:child_process');
vi.mock('@agent/core/secure-io', () => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
}));

describe('mission-control lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pathResolver.missionDir).mockReturnValue('/tmp/mission');
    vi.mocked(pathResolver.knowledge).mockReturnValue('/tmp/knowledge/index.json');
  });

  it('should throw error if sudo is required but not approved', async () => {
    const mockContract = {
      skill: 'test-skill',
      action: 'run',
      safety_gate: { require_sudo: true },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(safeReadFile).mockReturnValue(JSON.stringify(mockContract));

    await expect(orchestrate('contract.json', false)).rejects.toThrow('SUDO_REQUIRED');
  });

  it('should execute skill if approved and all paths resolve', async () => {
    const mockContract = { skill: 'test-skill', args: '--foo' };
    const mockIndex = { s: [{ n: 'test-skill', path: 'skills/test', m: 'dist/index.js' }] };
    
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(safeReadFile).mockImplementation((p: any) => {
      if (p.includes('contract.json')) return JSON.stringify(mockContract);
      if (p.includes('index.json')) return JSON.stringify(mockIndex);
      return '';
    });
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ status: 'success' }) as any);

    const result = await orchestrate('contract.json', true);
    expect(result.status).toBe('success');
    expect(result.skill).toBe('test-skill');
  });
});
