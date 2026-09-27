import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { extractReleaseSection } from './extract_changelog_section.js';
import {
  assembleChangelog,
  loadChangelogFragments,
  parseChangelogFragment,
  type ChangelogFragment,
} from './assemble_changelog.js';

const BASE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- existing added entry',
  '',
  '### Fixed',
  '',
  '- existing fix',
  '',
  '## [0.1.0] - 2026-01-01',
  '',
  '### Added',
  '',
  '- released entry',
  '',
].join('\n');

function fragment(
  fileName: string,
  category: ChangelogFragment['category'],
  body: string
): ChangelogFragment {
  return { fileName, category, body };
}

describe('assemble_changelog', () => {
  it('accepts a well-formed fragment', () => {
    const parsed = parseChangelogFragment(
      'draw-verb.md',
      '---\ncategory: Added\n---\n\n- **Draw** — prompt to image.\n'
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.fragment).toEqual({
      fileName: 'draw-verb.md',
      category: 'Added',
      body: '- **Draw** — prompt to image.',
    });
  });

  it('rejects malformed fragments with actionable reasons', () => {
    expect(
      parseChangelogFragment('Bad Name.md', '---\ncategory: Added\n---\n- x\n').errors
    ).toEqual(['Bad Name.md: name must match <short-slug>.md (lowercase letters, digits, dashes)']);
    expect(parseChangelogFragment('x.md', '- no front-matter\n').errors[0]).toContain(
      "missing '---' front-matter"
    );
    expect(
      parseChangelogFragment('x.md', '---\ncategory: Improved\n---\n- x\n').errors[0]
    ).toContain('category must be one of');
    expect(
      parseChangelogFragment('x.md', '---\ncategory: Fixed\npr: 12\n---\n- x\n').errors
    ).toEqual(['x.md: unknown front-matter field: pr']);
    expect(
      parseChangelogFragment('x.md', '---\ncategory: Fixed\n---\nplain text\n').errors
    ).toEqual(["x.md: body must be a Markdown list item starting with '- '"]);
    expect(
      parseChangelogFragment('x.md', '---\ncategory: Fixed\n---\n- x\n\n### Sub\n').errors
    ).toEqual(['x.md: body must not contain headings (the category picks the heading)']);
    expect(parseChangelogFragment('x.md', '---\ncategory: Fixed\n---\n\n').errors).toEqual([
      'x.md: body is empty',
    ]);
  });

  it('inserts fragments newest-first under the matching Unreleased heading only', () => {
    const result = assembleChangelog(BASE, [
      fragment('b-second.md', 'Added', '- second added'),
      fragment('a-first.md', 'Added', '- first added\n  continued line'),
      fragment('fix.md', 'Fixed', '- new fix'),
    ]);
    const unreleased = extractReleaseSection(result, 'Unreleased');
    expect(unreleased).toContain(
      '### Added\n\n- first added\n  continued line\n- second added\n- existing added entry'
    );
    expect(unreleased).toContain('### Fixed\n\n- new fix\n- existing fix');
    expect(extractReleaseSection(result, '0.1.0')).toContain('### Added\n\n- released entry\n');
    expect(extractReleaseSection(result, '0.1.0')).not.toContain('first added');
  });

  it('creates a missing category heading in Keep a Changelog order', () => {
    const result = assembleChangelog(BASE, [
      fragment('rm.md', 'Removed', '- dropped legacy flag'),
      fragment('sec.md', 'Security', '- tightened egress'),
    ]);
    const unreleased = extractReleaseSection(result, 'Unreleased');
    expect(unreleased.indexOf('### Removed')).toBeGreaterThan(unreleased.indexOf('### Added'));
    expect(unreleased.indexOf('### Removed')).toBeLessThan(unreleased.indexOf('### Fixed'));
    expect(unreleased).toContain('### Removed\n\n- dropped legacy flag\n\n### Fixed');
    expect(unreleased).toContain('- existing fix\n\n### Security\n\n- tightened egress');
    expect(result).toContain('- tightened egress\n\n## [0.1.0] - 2026-01-01');
  });

  it('is a no-op without fragments', () => {
    expect(assembleChangelog(BASE, [])).toBe(BASE);
  });

  it('keeps the repository fragments valid', () => {
    expect(loadChangelogFragments().errors).toEqual([]);
    const readme = String(
      safeReadFile(pathResolver.rootResolve('changelog.d/README.md'), { encoding: 'utf8' })
    );
    expect(readme).toContain('category: Added');
  });
});
