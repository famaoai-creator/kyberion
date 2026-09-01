import { describe, expect, it } from 'vitest';
import { compileSchema } from './foundation/ajv.js';
import { loadMissionManagementConfig } from './mission-management-config.js';
import { pathResolver } from './path-resolver.js';

describe('mission management config', () => {
  it('loads the mission path configuration through its governed schema', () => {
    const config = loadMissionManagementConfig();
    expect(config?.version).toBe('1.1.0');
    expect(config?.directories.confidential).toBe('active/missions/confidential');
    expect(config?.directories.archive).toBe('active/archive/missions');
  });

  it('rejects absolute and parent-traversing directory paths at the schema boundary', () => {
    const validate = compileSchema(
      pathResolver.rootResolve('knowledge/product/schemas/mission-management.schema.json')
    );
    expect(validate({ version: '1.1.0', directories: { archive: '../outside' } })).toBe(false);
    expect(validate({ version: '1.1.0', directories: { archive: '/outside' } })).toBe(false);
    expect(
      validate({ version: '1.1.0', directories: { archive: 'active/archive/missions' } })
    ).toBe(true);
  });
});
