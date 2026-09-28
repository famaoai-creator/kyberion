import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { GOVERNED_ARTIFACT_ROLES } from '../workforce/artifact-store.js';
import { pathResolver } from '../path-resolver.js';
import { compileSchemaFromPath } from '../schema-loader.js';
import { safeReadFile } from '../secure-io.js';
import {
  getSurfaceCoordinationRole,
  _resetSurfaceCoordinationRoleMapCacheForTests,
} from './surface-coordination-role-map.js';
import { withoutSchemaMetadata } from '../test-governance-payload.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('surface-coordination-role-map', () => {
  it('maps surfaces to governed roles', () => {
    _resetSurfaceCoordinationRoleMapCacheForTests();
    expect(getSurfaceCoordinationRole('slack')).toBe('slack_bridge');
    expect(getSurfaceCoordinationRole('chronos')).toBe('chronos_gateway');
    expect(getSurfaceCoordinationRole('presence')).toBe('surface_runtime');
    expect(getSurfaceCoordinationRole('unknown')).toBe('surface_runtime');
  });

  it('emits a map that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/surface-coordination-role-map.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const payload = withoutSchemaMetadata(
      JSON.parse(
        safeReadFile(
          path.join(
            pathResolver.rootDir(),
            'knowledge/product/governance/surface-coordination-role-map.json'
          ),
          { encoding: 'utf8' }
        ) as string
      )
    );
    expect(validate(payload), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('only admits GovernedArtifactRole values, for the public map and a personal overlay (S4)', () => {
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/surface-coordination-role-map.schema.json'
    );
    const schema = JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string);
    expect([...schema.properties.entries.items.properties.role.enum].sort()).toEqual(
      [...GOVERNED_ARTIFACT_ROLES].sort()
    );
    const validate = compileSchemaFromPath(new Ajv({ allErrors: true }), schemaPath);
    const overlay = (role: string) => ({ version: '1.0.0', entries: [{ surface: 'x', role }] });
    expect(validate(overlay('sovereign_concierge'))).toBe(true);
    expect(validate(overlay('ecosystem_architect'))).toBe(false);
  });
});
