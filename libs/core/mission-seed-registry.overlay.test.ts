import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync, safeWriteFile } from './secure-io.js';

const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(() => null as string | null),
}));

vi.mock('./customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
}));

const runtimeDir = pathResolver.shared('runtime/mission-seeds');
const customerDir = pathResolver.sharedTmp('customer-mission-seeds');

describe('mission-seed-registry overlay', () => {
  beforeEach(() => {
    safeRmSync(runtimeDir, { recursive: true, force: true });
    safeRmSync(customerDir, { recursive: true, force: true });
    mocks.customerRoot.mockReturnValue(customerDir);
  });

  afterEach(() => {
    safeRmSync(runtimeDir, { recursive: true, force: true });
    safeRmSync(customerDir, { recursive: true, force: true });
    mocks.customerRoot.mockReturnValue(null);
  });

  it('prefers customer mission seeds over runtime seeds when ids overlap', async () => {
    safeWriteFile(`${runtimeDir}/MSD-OVERLAY.json`, JSON.stringify({
      seed_id: 'MSD-OVERLAY',
      project_id: 'PRJ-RUNTIME',
      title: 'Runtime seed',
      summary: 'Runtime seed summary.',
      status: 'ready',
      specialist_id: 'runtime-specialist',
      created_at: new Date('2026-05-09T00:00:00.000Z').toISOString(),
    }, null, 2));

    safeWriteFile(`${customerDir}/MSD-OVERLAY.json`, JSON.stringify({
      seed_id: 'MSD-OVERLAY',
      project_id: 'PRJ-CUSTOMER',
      title: 'Customer seed',
      summary: 'Customer seed summary.',
      status: 'ready',
      specialist_id: 'customer-specialist',
      created_at: new Date('2026-05-09T00:00:00.000Z').toISOString(),
    }, null, 2));

    const { loadMissionSeedRecord, listMissionSeedRecords } = await import('./mission-seed-registry.js');
    expect(loadMissionSeedRecord('MSD-OVERLAY')?.project_id).toBe('PRJ-CUSTOMER');
    expect(listMissionSeedRecords()).toEqual([
      expect.objectContaining({
        seed_id: 'MSD-OVERLAY',
        project_id: 'PRJ-CUSTOMER',
        title: 'Customer seed',
      }),
    ]);
  });

  it('falls back to runtime mission seeds when no customer overlay exists', async () => {
    safeWriteFile(`${runtimeDir}/MSD-RUNTIME.json`, JSON.stringify({
      seed_id: 'MSD-RUNTIME',
      project_id: 'PRJ-RUNTIME',
      title: 'Runtime seed',
      summary: 'Runtime seed summary.',
      status: 'ready',
      specialist_id: 'runtime-specialist',
      created_at: new Date('2026-05-09T00:00:00.000Z').toISOString(),
    }, null, 2));

    const { loadMissionSeedRecord, listMissionSeedRecords } = await import('./mission-seed-registry.js');
    expect(loadMissionSeedRecord('MSD-RUNTIME')?.project_id).toBe('PRJ-RUNTIME');
    expect(listMissionSeedRecords().map((record) => record.seed_id)).toEqual(['MSD-RUNTIME']);
  });
});
