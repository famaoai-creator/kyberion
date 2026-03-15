import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();

describe('Role capability map contract', () => {
  it('validates the role capability map against its schema', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/schemas/role-capability-map.schema.json'), { encoding: 'utf8' }) as string,
    );
    const roleMap = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/personalities/roles.json'), { encoding: 'utf8' }) as string,
    );

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(roleMap);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('uses capabilities instead of legacy skills arrays', () => {
    const roleMap = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/personalities/roles.json'), { encoding: 'utf8' }) as string,
    ) as {
      roles: Record<string, { capabilities?: string[]; skills?: string[] }>;
    };

    for (const role of Object.values(roleMap.roles)) {
      expect(Array.isArray(role.capabilities)).toBe(true);
      expect(role.skills).toBeUndefined();
    }
  });
});
