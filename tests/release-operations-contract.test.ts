import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Release operations contract', () => {
  it('keeps the release workflow on built validation, changelog extraction, and release publication', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('permissions:');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('pnpm run validate');
    expect(workflow).toContain('pnpm run check:golden');
    expect(workflow).toContain('pnpm run release:notes -- --ref "${{ github.ref_name }}" --output active/shared/tmp/release-notes.md');
    expect(workflow).toContain('gh release create "${{ github.ref_name }}"');
  });

  it('documents the release notes extractor and leaves migration runner as the remaining follow-up', () => {
    const packageJson = read('package.json');
    expect(packageJson).toContain('"release:notes": "node dist/scripts/extract_changelog_section.js"');

    const releaseOps = read('docs/developer/RELEASE_OPERATIONS.md');
    expect(releaseOps).toContain('pnpm run release:notes -- --ref "v${NEW_VERSION}" --output active/shared/tmp/release-notes.md');
    expect(releaseOps).toContain('Automated release workflow (`.github/workflows/release.yml`)');
    expect(releaseOps).toContain('Migration runner (`scripts/run_migrations.ts`)');
  });

  it('extracts a tagged changelog section with the built helper contract', async () => {
    const { extractReleaseSection, normalizeRef } = await import('../scripts/extract_changelog_section.js');
    expect(normalizeRef('v0.1.2')).toBe('0.1.2');

    const changelog = read('CHANGELOG.md');
    const section = extractReleaseSection(changelog, 'Unreleased');
    expect(section).toContain('## [Unreleased]');
    expect(section).toContain('Productization roadmap');
  });
});
