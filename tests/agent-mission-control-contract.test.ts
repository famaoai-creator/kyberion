import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

describe('Agent mission control concept contract', () => {
  it('defines mission control schemas and coordination directories', () => {
    const config = JSON.parse(
      safeReadFile('knowledge/public/governance/mission-management-config.json', { encoding: 'utf8' }) as string
    );

    expect(config.mission_control_model).toBe('single-owner-multi-worker');
    expect(config.directories.global_coordination).toBe('active/shared/coordination');
    expect(config.directories.mission_coordination).toBe('coordination');
  });

  it('ships core schemas for leases, tasks, and mission events', () => {
    expect(safeExistsSync('knowledge/public/schemas/mission-lease.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/public/schemas/task-contract.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/public/schemas/mission-event.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/public/architecture/agent-mission-control-model.md')).toBe(true);
  });
});
