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
    expect(workflow).toContain('pnpm run check -- --scope release');
    expect(workflow).toContain('pnpm run release:source-archive');
    expect(workflow).toContain('pnpm run release:source-archive -- --check');
    expect(workflow).toContain('pnpm kyberion release install-smoke');
    expect(workflow).not.toContain('pnpm run check:golden');
    expect(workflow).toContain(
      'pnpm run release:notes -- --ref "${{ github.ref_name }}" --output active/shared/tmp/release-notes.md'
    );
    expect(workflow).toContain('gh release create "${{ github.ref_name }}"');
    expect(workflow).toContain('SHA256SUMS');
  });

  it('documents the release notes extractor and migration runner contract', () => {
    const packageJson = read('package.json');
    expect(packageJson).toContain(
      '"release:notes": "node dist/scripts/extract_changelog_section.js"'
    );
    expect(packageJson).toContain(
      '"release:source-archive": "node --import ./scripts/ts-loader.mjs scripts/source_archive.ts"'
    );
    expect(packageJson).not.toContain('"release:install-smoke"');
    // SX-05: the TypeScript entrypoint runner was unified on the ts-loader
    // import hook; these scripts no longer shell out through `pnpm exec tsx`.
    expect(packageJson).toContain(
      '"check:pr-title": "node --import ./scripts/ts-loader.mjs scripts/check_pr_title.ts"'
    );
    expect(packageJson).toContain(
      '"migration": "node --import ./scripts/ts-loader.mjs scripts/run_migrations.ts"'
    );

    const releaseOps = read('docs/developer/RELEASE_OPERATIONS.md');
    expect(releaseOps).toContain(
      'pnpm run release:notes -- --ref "v${NEW_VERSION}" --output active/shared/tmp/release-notes.md'
    );
    expect(releaseOps).toContain('pnpm run release:source-archive');
    expect(releaseOps).toContain('pnpm kyberion release install-smoke');
    expect(releaseOps).toContain('Automated release workflow (`.github/workflows/release.yml`)');
    expect(releaseOps).toContain('Migration runner (`scripts/run_migrations.ts`)');
    expect(releaseOps).toContain('PR titles that do not match the pattern');
    expect(releaseOps).toContain('pnpm run check:contract-semver -- --rebaseline');
    expect(releaseOps).toContain('scripts/contract-baseline.json');
    expect(releaseOps).toContain('Migration required: None');
    expect(releaseOps).toContain('pnpm migration -- --dry-run');
  });

  it('extracts a tagged changelog section with the built helper contract', async () => {
    const { extractReleaseSection, normalizeRef } =
      await import('../scripts/extract_changelog_section.js');
    expect(normalizeRef('v0.1.2')).toBe('0.1.2');

    const changelog = read('CHANGELOG.md');
    const section = extractReleaseSection(changelog, 'Unreleased');
    expect(section).toContain('## [Unreleased]');
    expect(section).toContain('Productization roadmap');
    expect(section).toContain('### Migration required');
    expect(section).toContain('None for the current unreleased changes');
  });

  it('keeps migration docs aligned with the shipped migration runner', () => {
    const migrationReadme = read('migration/README.md');
    expect(migrationReadme).toContain('pnpm migration');
    expect(migrationReadme).toContain('Migration required: None');
    expect(migrationReadme).not.toContain('until the runner ships');
  });
});
