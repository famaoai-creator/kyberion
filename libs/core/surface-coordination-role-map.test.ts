import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { getSurfaceCoordinationRole, resetSurfaceCoordinationRoleMapCache } from './surface-coordination-role-map.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('surface-coordination-role-map', () => {
  it('maps surfaces to governed roles', () => {
    resetSurfaceCoordinationRoleMapCache();
    expect(getSurfaceCoordinationRole('slack')).toBe('slack_bridge');
    expect(getSurfaceCoordinationRole('chronos')).toBe('chronos_gateway');
    expect(getSurfaceCoordinationRole('presence')).toBe('surface_runtime');
    expect(getSurfaceCoordinationRole('unknown')).toBe('surface_runtime');
  });

  it('emits a map that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/product/schemas/surface-coordination-role-map.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const payload = JSON.parse(
      safeReadFile(path.join(pathResolver.rootDir(), 'knowledge/product/governance/surface-coordination-role-map.json'), { encoding: 'utf8' }) as string,
    );
    expect(validate(payload), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
