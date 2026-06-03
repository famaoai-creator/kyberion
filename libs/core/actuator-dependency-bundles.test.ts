import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { getActuatorDependencyBundle, loadActuatorDependencyBundles } from './actuator-dependency-bundles.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('actuator-dependency-bundles', () => {
  it('loads the canonical bundles from knowledge', () => {
    const bundles = loadActuatorDependencyBundles();
    expect(bundles.version).toBe('1.0.0');
    expect(bundles.bundles.map((bundle) => bundle.actuator)).toEqual(
      expect.arrayContaining(['core', 'browser', 'voice', 'media-generation', 'meeting', 'all']),
    );
  });

  it('resolves a bundle from knowledge', () => {
    expect(getActuatorDependencyBundle('voice')?.dependency_ids).toEqual([
      'node22',
      'python3',
      'native-tts',
      'whisper',
      'ffmpeg',
    ]);
  });

  it('emits a bundle set that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/product/schemas/actuator-dependency-bundles.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const payload = loadActuatorDependencyBundles();
    expect(validate(payload), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
