import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspectSchemas } from './lib';
import * as fsUtils from '@agent/core/fs-utils';

vi.mock('@agent/core/fs-utils');

describe('inspectSchemas', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('finds schema files', () => {
    vi.mocked(fsUtils.walk).mockImplementation(function* () {
      yield '/root/db/schema.sql';
      yield '/root/api/openapi.schema.json';
      yield '/root/src/index.ts';
    });

    const result = inspectSchemas('/root');

    expect(result.count).toBe(2);
    expect(result.schemas).toContainEqual({ name: 'schema.sql', path: 'db/schema.sql' });
    expect(result.schemas).toContainEqual({
      name: 'openapi.schema.json',
      path: 'api/openapi.schema.json',
    });
  });

  it('returns empty list if no schemas found', () => {
    vi.mocked(fsUtils.walk).mockImplementation(function* () {
      yield '/root/README.md';
    });

    const result = inspectSchemas('/root');
    expect(result.count).toBe(0);
  });
});
