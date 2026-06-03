import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { findSkillInstallPackageMapEntry, loadSkillInstallPackageMap } from './skill-install-package-map.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('skill-install-package-map', () => {
  it('loads the canonical map from knowledge', () => {
    const map = loadSkillInstallPackageMap();
    expect(map.version).toBe('1.0.0');
    expect(findSkillInstallPackageMapEntry('whisper.cpp')).toMatchObject({
      id: 'whisper',
      install_type: 'pip',
      package_name: 'faster-whisper',
    });
  });

  it('emits a map that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/product/schemas/skill-install-package-map.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const map = loadSkillInstallPackageMap();
    expect(validate(map), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
