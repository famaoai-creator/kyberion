import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

import {
  readDesignMdCatalogTextFile,
  runImportDesignMdCatalog,
} from './import_design_md_catalog.js';

describe('import design-md catalog entrypoint', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(pathResolver.sharedTmp('design-md-test-'));
    const sourceDir = path.join(fixtureDir, 'design-md', 'example');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'DESIGN.md'),
      [
        '# Design System: Example',
        '',
        '## 1. Visual Theme & Atmosphere',
        '',
        'A calm and focused interface.',
        '',
        '## 2. Color Palette & Roles',
        '',
        '### Primary',
        '- **Main** (`#123456`): Primary brand color',
        '',
        '## 3. Typography Rules',
        '',
        '### Font Family',
        '- **Body**: `Inter`',
        '',
        '## 4. Layout Principles',
        '- Keep the hierarchy clear',
        '',
        '## 5. Component Stylings',
        '### Button',
        '',
        '## 6. Agent Prompt Guide',
        '- Use generous spacing',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'README.md'),
      '- [**Example**](https://example.test/design-md/example/) - Example catalog entry\n'
    );
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('honors dry-run and shared output flags without writing generated files', async () => {
    const outputPath = pathResolver.rootResolve(
      'knowledge/public/design-patterns/media-templates/themes/design-md-imports.json'
    );
    const before = fs.readFileSync(outputPath, 'utf8');

    const result = await runImportDesignMdCatalog([
      '--source',
      path.join(fixtureDir, 'design-md'),
      '--readme',
      path.join(fixtureDir, 'README.md'),
      '--dry-run',
      '--json',
      '--quiet',
    ]);

    expect(result?.files).toHaveLength(3);
    expect(result?.changed).toContain(outputPath);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(before);
  });

  it('uses the governed parser for generated catalog comparison', () => {
    const source = String(
      fs.readFileSync(pathResolver.rootResolve('scripts/import_design_md_catalog.ts'), 'utf8')
    );
    expect(source).toContain('parseSafeJsonObjectInput');
    expect(source).not.toContain('JSON.parse(content)');
  });

  it('rejects a directory before reading design catalog content', () => {
    expect(() => readDesignMdCatalogTextFile(fixtureDir)).toThrow('must be a regular file');
  });

  it('rejects source paths outside the repository before reading them', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const result = await runImportDesignMdCatalog(['--source', '/tmp']);

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
