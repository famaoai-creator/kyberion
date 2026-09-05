import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { pathResolver } from './path-resolver.js';
import { loadPerspectives } from './persona-loader.js';

const directory = pathResolver.shared(`tmp/.persona-loader-directory-${process.pid}`);

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('persona loader resource boundary', () => {
  it('rejects a perspective matrix replaced by a directory', () => {
    fs.mkdirSync(directory, { recursive: true });

    expect(() => loadPerspectives(directory)).toThrow(
      '[PERSONA_LOADER] perspective matrix must be a regular file'
    );
  });
});
