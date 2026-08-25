import path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchema } from './ajv.js';
import { defineCatalog } from './governed-catalog.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  clamp,
  getRegisteredEnv,
  normalizeText,
  parseIso,
  setRegisteredEnv,
  slugify,
  truncateNormalizedText,
} from './index.js';

describe('foundation helpers', () => {
  it('keeps deterministic text and numeric semantics in one place', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
    expect(truncateNormalizedText('  hello   world  ', 8)).toBe('hello...');
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(clamp(12, 0, 10)).toBe(10);
    expect(parseIso('2026-08-25T00:00:00.000Z').toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('rejects invalid ranges and timestamps', () => {
    expect(() => clamp(1, 2, 0)).toThrow('Invalid clamp range');
    expect(() => parseIso('not-a-date')).toThrow('Invalid ISO timestamp');
  });

  it('registers external refs before compiling actuator schemas', () => {
    const validateVoiceAction = compileSchema(
      path.resolve(process.cwd(), 'schemas/voice-action.schema.json')
    );
    const validateVideoAction = compileSchema(
      path.resolve(process.cwd(), 'schemas/video-composition-action.schema.json')
    );

    expect(validateVoiceAction({ action: 'health', params: {} })).toBe(true);
    expect(validateVideoAction({ action: 'list_video_composition_templates', params: {} })).toBe(
      true
    );
  });

  it('reloads governed catalogs when the file signature changes', () => {
    const directory = pathResolver.sharedTmp('foundation-catalog-test');
    const catalogPath = path.join(directory, 'catalog.json');
    safeMkdir(directory, { recursive: true });
    safeWriteFile(catalogPath, JSON.stringify({ version: 1 }));
    const catalog = defineCatalog<{ version: number }>({
      id: 'foundation-catalog-test',
      path: catalogPath,
      schema: ((value: unknown): value is { version: number } => {
        return (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { version?: unknown }).version === 'number'
        );
      }) as ValidateFunction<{ version: number }>,
      fallback: { version: 0 },
    });

    expect(catalog.load()).toEqual({ version: 1 });
    safeWriteFile(catalogPath, JSON.stringify({ version: 200 }));
    expect(catalog.load()).toEqual({ version: 200 });
    safeRmSync(directory, { recursive: true, force: true });
  });

  it('scopes environment setup and restore through the foundation boundary', () => {
    const environment: Record<string, string | undefined> = {};
    setRegisteredEnv('KYBERION_FOUNDATION_TEST', 'enabled', environment);
    expect(getRegisteredEnv('KYBERION_FOUNDATION_TEST', { env: environment })).toBe('enabled');
    expect(environment.KYBERION_FOUNDATION_TEST).toBe('enabled');
    setRegisteredEnv('KYBERION_FOUNDATION_TEST', undefined, environment);
    expect(environment.KYBERION_FOUNDATION_TEST).toBeUndefined();
  });
});
