import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runImportDesignMdCatalog } from './import_design_md_catalog.js';

describe('import design-md catalog entrypoint', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/design-md-test-'));
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
    const outputPath = path.join(
      process.cwd(),
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

  it('rejects source paths outside the repository before reading them', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const result = await runImportDesignMdCatalog(['--source', '/tmp']);

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
