import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSolutionCatalogAtPath } from './customer-conversation.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';

const CATALOG_PATH = pathResolver.sharedTmp('customer-conversation-solution-catalog-test.json');
const CATALOG_LINK_PATH = pathResolver.sharedTmp(
  'customer-conversation-solution-catalog-link.json'
);

afterEach(() => {
  safeRmSync(CATALOG_PATH, { recursive: true, force: true });
  safeRmSync(CATALOG_LINK_PATH, { recursive: true, force: true });
});

describe('customer conversation grounding loader', () => {
  it('loads a schema-valid solution catalog', () => {
    safeWriteFile(
      CATALOG_PATH,
      JSON.stringify({
        version: '1.0.0',
        solutions: [
          {
            id: 'ops',
            name: 'Operations',
            summary: 'Operational support',
            capabilities: ['reports'],
            limitations: ['No 24/7 guarantee'],
          },
        ],
      })
    );

    expect(loadSolutionCatalogAtPath(CATALOG_PATH)).toMatchObject({ version: '1.0.0' });
  });

  it('does not expose schema-invalid or directory catalogs as grounding', () => {
    safeWriteFile(CATALOG_PATH, JSON.stringify({ version: '1.0.0', unexpected: true }));
    expect(loadSolutionCatalogAtPath(CATALOG_PATH)).toBeNull();

    safeRmSync(CATALOG_PATH, { recursive: true, force: true });
    safeMkdir(CATALOG_PATH, { recursive: true });
    expect(loadSolutionCatalogAtPath(CATALOG_PATH)).toBeNull();
  });

  it('does not follow symlink catalogs', () => {
    safeWriteFile(CATALOG_PATH, JSON.stringify({ version: '1.0.0', solutions: [] }));
    safeRmSync(CATALOG_LINK_PATH, { recursive: true, force: true });
    safeSymlinkSync(CATALOG_PATH, CATALOG_LINK_PATH);

    expect(loadSolutionCatalogAtPath(CATALOG_LINK_PATH)).toBeNull();
  });
});
