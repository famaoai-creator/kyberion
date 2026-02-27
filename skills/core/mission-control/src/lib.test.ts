import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { orchestrate, executeCommand } from './lib';
import * as pathResolver from '@agent/core/path-resolver';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('@agent/core/path-resolver');

// Helper to mock executeCommand since it's exported
// We can't easily mock exported function in the same module without refactoring to a class or object,
// but for this PoC we focus on the orchestration flow logic.

describe('mission-control lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pathResolver.missionDir).mockReturnValue('/tmp/mission');
  });

  it('should throw error if sudo is required but not approved', async () => {
    const mockContract = {
      skill: 'test-skill',
      action: 'run',
      safety_gate: { require_sudo: true },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockContract));

    await expect(orchestrate('contract.json', false)).rejects.toThrow('SUDO_REQUIRED');
  });

  it('should continue if sudo is required and approved', async () => {
    // This test would need a mock for executeCommand which is in the same module.
    // In a full implementation, we'd move executeCommand to a separate file or utility.
  });
});
