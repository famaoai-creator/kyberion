import { describe, expect, it } from 'vitest';
import { loadProjectStandards } from './config-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

describe('config-loader', () => {
  it('loads project standards from governed common knowledge', () => {
    const expected = JSON.parse(
      safeReadFile(pathResolver.knowledge('public/common/project_standards.json'), { encoding: 'utf8' }) as string,
    ) as {
      ignore_dirs?: string[];
      ignore_extensions?: string[];
    };

    const standards = loadProjectStandards();

    expect(standards.ignore_dirs).toEqual(expected.ignore_dirs);
    expect(standards.ignore_extensions).toEqual(expected.ignore_extensions);
  });
});
