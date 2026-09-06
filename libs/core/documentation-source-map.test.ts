import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDocumentationSourceMapAtPath } from './documentation-source-map.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const testRoot = pathResolver.sharedTmp(`documentation-source-map-loader-${process.pid}`);
const testPath = path.join(testRoot, 'source-map.json');

afterEach(() => {
  safeRmSync(testRoot, { recursive: true, force: true });
});

describe('documentation source map catalog', () => {
  it('loads the checked-in source map through its schema', () => {
    const sourceMap = loadDocumentationSourceMapAtPath();

    expect(sourceMap).toMatchObject({
      manifest_version: 1,
      categories: expect.arrayContaining([
        expect.objectContaining({ id: 'status' }),
        expect.objectContaining({ id: 'concept' }),
        expect.objectContaining({ id: 'onboarding' }),
      ]),
    });
  });

  it('rejects unknown fields and traversal paths', () => {
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(
      testPath,
      JSON.stringify({
        manifest_version: 1,
        categories: [
          {
            id: 'status',
            canonical: '../outside.md',
            unexpected: true,
          },
        ],
        entrypoints: ['README.md'],
      })
    );

    expect(() => loadDocumentationSourceMapAtPath(testPath)).toThrow(
      'Invalid catalog documentation-source-map'
    );
  });
});
