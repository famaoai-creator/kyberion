import { afterAll, describe, expect, it } from 'vitest';
import { safeExistsSync, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import type { GitRunner } from '../run_checks.js';
import {
  assertDocsImpactMapShape,
  evaluateDocsImpact,
  main,
  renderDocsImpactMarkdown,
  writeDocsImpactReport,
  type DocsImpactMap,
} from './check_docs_impact.js';
import type { GitRunner as PromotionGitRunner } from '@agent/core/knowledge/memory-promotion-git';

const map: DocsImpactMap = {
  rules: [
    {
      change: 'package.json',
      docs: ['docs/CLI_REFERENCE.md', 'AGENTS.md'],
      note: 'operator surface',
    },
    {
      change: 'knowledge/product/governance/*.json',
      docs: ['knowledge/product/governance/'],
      note: 'sibling docs',
    },
    { change: 'scripts/**/*.ts', docs: ['docs/COMPONENT_MAP.md'] },
    { change: 'docs/**', docs: [], note: 'doc change itself' },
  ],
  ignore: ['tests/**', '**/*.test.ts', 'changelog.d/**'],
};

describe('evaluateDocsImpact', () => {
  it('classifies mapped docs as updated or not_updated', () => {
    const report = evaluateDocsImpact(['package.json', 'docs/CLI_REFERENCE.md'], map);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        change: 'package.json',
        doc: 'docs/CLI_REFERENCE.md',
        status: 'updated',
      })
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ change: 'package.json', doc: 'AGENTS.md', status: 'not_updated' })
    );
    expect(report.counts).toEqual({ updated: 1, not_updated: 1 });
  });

  it('treats a trailing-slash doc target as a directory prefix', () => {
    const report = evaluateDocsImpact(
      ['knowledge/product/governance/x.json', 'knowledge/product/governance/runbook.md'],
      map
    );
    expect(report.findings[0]).toMatchObject({
      doc: 'knowledge/product/governance/',
      status: 'updated',
    });
  });

  it('a directory target is not satisfied by the triggering data file itself', () => {
    const report = evaluateDocsImpact(['knowledge/product/governance/x.json'], map);
    expect(report.findings[0]).toMatchObject({
      doc: 'knowledge/product/governance/',
      status: 'not_updated',
    });
  });

  it('ignores test and changelog paths, marks doc-only changes as no-doc-expected', () => {
    const report = evaluateDocsImpact(
      ['tests/foo.test.ts', 'changelog.d/x.md', 'docs/QUICKSTART.md'],
      map
    );
    expect(report.ignored).toEqual(['changelog.d/x.md', 'tests/foo.test.ts']);
    expect(report.findings).toEqual([]);
    expect(report.noDocsExpected).toContainEqual(
      expect.objectContaining({ change: 'docs/QUICKSTART.md' })
    );
  });

  it('lists changed paths with no matching rule as unmapped', () => {
    const report = evaluateDocsImpact(['src/unknown/file.c'], map);
    expect(report.unmapped).toEqual(['src/unknown/file.c']);
  });

  it('deduplicates identical (change, doc) findings across overlapping rules', () => {
    const overlapping: DocsImpactMap = {
      rules: [
        { change: 'a/**', docs: ['docs/x.md'] },
        { change: 'a/b.ts', docs: ['docs/x.md', 'docs/y.md'] },
      ],
    };
    const report = evaluateDocsImpact(['a/b.ts'], overlapping);
    expect(report.findings.filter((f) => f.doc === 'docs/x.md')).toHaveLength(1);
    expect(report.findings).toHaveLength(2);
  });

  it('prefers a docs-expecting rule over a no-docs rule for the same path', () => {
    const overlap: DocsImpactMap = {
      rules: [
        { change: '**/*.md', docs: [], note: 'prose' },
        { change: 'AGENTS.md', docs: ['docs/GLOSSARY.md'] },
      ],
    };
    const report = evaluateDocsImpact(['AGENTS.md'], overlap);
    expect(report.findings).toHaveLength(1);
    expect(report.noDocsExpected).toHaveLength(0);
  });
});

describe('renderDocsImpactMarkdown', () => {
  it('names the not_updated surfaces and the resolution block', () => {
    const report = evaluateDocsImpact(['package.json'], map);
    const md = renderDocsImpactMarkdown(report);
    expect(md).toContain('`docs/CLI_REFERENCE.md`');
    expect(md).toContain('`AGENTS.md`');
    expect(md).toContain('## Resolution');
    expect(md).toContain('not_updated');
  });
});

describe('assertDocsImpactMapShape', () => {
  it('rejects malformed maps with a named error instead of a TypeError', () => {
    for (const bad of [
      null,
      { rules: 'nope' },
      { rules: [{ docs: [] }] },
      { rules: [{ change: 'a', docs: 'b.md' }] },
      { rules: [], ignore: 'x' },
    ]) {
      expect(() => assertDocsImpactMapShape(bad)).toThrow('docs-impact map');
    }
  });
});

describe('main', () => {
  const tmpDir = `active/shared/tmp/docs-impact-main-${process.pid}`;
  const tmpMap = `${tmpDir}/map.json`;
  const tmpOut = `${tmpDir}/report.md`;

  afterAll(() => {
    const dir = pathResolver.rootResolve(tmpDir);
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('prints the report and exits non-zero under --strict when docs lag', async () => {
    safeWriteFile(pathResolver.rootResolve(tmpMap), JSON.stringify(map));
    const printed: string[] = [];
    await expect(
      main(['--files', 'package.json', '--map', tmpMap, '--strict'], (v) => printed.push(String(v)))
    ).rejects.toThrow('not updated');
    expect(printed.join('\n')).toContain('Docs impact report');
  });

  it('writes the markdown report to --out and uses injected git for the base', async () => {
    safeWriteFile(pathResolver.rootResolve(tmpMap), JSON.stringify(map));
    const git: GitRunner = (args) => {
      if (args[0] === 'merge-base') return { status: 0, stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'diff') return { status: 0, stdout: 'docs/QUICKSTART.md\n', stderr: '' };
      if (args[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected git call' };
    };
    const printed: string[] = [];
    await main(
      ['--base', 'main', '--map', tmpMap, '--out', tmpOut],
      (v) => printed.push(String(v)),
      false,
      { git }
    );
    const md = String(printed.join(''));
    expect(md).toContain('Base: main (merge-base abc123)');
    const outPath = pathResolver.rootResolve(tmpOut);
    expect(safeExistsSync(outPath)).toBe(true);
    safeRmSync(outPath);
  });
});

describe('writeDocsImpactReport --mission-root', () => {
  const missionRoot = '/fake/primary';
  const evidenceOut = `${missionRoot}/active/missions/public/MSN-X/evidence/docs-sync-report.md`;
  const gitRunner: PromotionGitRunner = (args, cwd) => {
    if (args.includes('--show-toplevel'))
      return {
        status: 0,
        stdout: `${cwd === missionRoot ? missionRoot : pathResolver.rootDir()}\n`,
        stderr: '',
      };
    if (args.includes('--show-prefix')) return { status: 0, stdout: '\n', stderr: '' };
    if (args.includes('--git-common-dir')) return { status: 0, stdout: '/repo/.git\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected git call' };
  };

  it('denies an outside-root --out when no --mission-root is given', () => {
    expect(() => writeDocsImpactReport(evidenceOut, undefined, 'report')).toThrow(
      /RESOURCE_PATH_SCOPE/
    );
  });

  it('denies an --out outside <mission-root>/active/missions/**', () => {
    expect(() =>
      writeDocsImpactReport(`${missionRoot}/etc/escape.md`, missionRoot, 'report', { gitRunner })
    ).toThrow(/RESOURCE_PATH_SCOPE/);
  });

  it('routes a mission-evidence --out through the sibling-worktree writer', () => {
    const written: { root: string; path: string; content: string }[] = [];
    writeDocsImpactReport(evidenceOut, missionRoot, 'report body', {
      gitRunner,
      worktreeWriter: ({ root, files }) => {
        for (const file of files) written.push({ root, path: file.path, content: file.content });
      },
    });
    expect(written).toEqual([
      {
        root: missionRoot,
        path: 'active/missions/public/MSN-X/evidence/docs-sync-report.md',
        content: 'report body',
      },
    ]);
  });

  it('routes a persona-denied same-checkout write through the governed writer', () => {
    const written: { root: string; path: string; content: string }[] = [];
    const sameCheckoutOut = `${pathResolver.rootDir()}/active/missions/public/MSN-X/evidence/docs-sync-report.md`;
    const sameRootGitRunner: PromotionGitRunner = (args, cwd) => {
      if (args.includes('--show-toplevel')) return { status: 0, stdout: `${cwd}\n`, stderr: '' };
      if (args.includes('--show-prefix')) return { status: 0, stdout: '\n', stderr: '' };
      if (args.includes('--git-common-dir'))
        return { status: 0, stdout: `${pathResolver.rootDir()}/.git\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected git call' };
    };
    writeDocsImpactReport(sameCheckoutOut, pathResolver.rootDir(), 'report body', {
      gitRunner: sameRootGitRunner,
      writeFile: () => {
        throw new Error(
          "[POLICY_VIOLATION] Persona 'check_docs_impact' with authority role 'check_docs_impact' is NOT authorized to write to 'active/missions/public/MSN-X/evidence/docs-sync-report.md'."
        );
      },
      worktreeWriter: ({ root, files }) => {
        for (const file of files) written.push({ root, path: file.path, content: file.content });
      },
    });
    expect(written).toEqual([
      {
        root: pathResolver.rootDir(),
        path: 'active/missions/public/MSN-X/evidence/docs-sync-report.md',
        content: 'report body',
      },
    ]);
  });

  it('propagates POLICY_VIOLATION denials that are not persona write-authority failures', () => {
    const sameCheckoutOut = `${pathResolver.rootDir()}/active/missions/public/MSN-X/evidence/docs-sync-report.md`;
    expect(() =>
      writeDocsImpactReport(sameCheckoutOut, missionRoot, 'report body', {
        gitRunner,
        writeFile: () => {
          throw new Error('[POLICY_VIOLATION] tenant.scope_violation: cross-tenant write denied');
        },
      })
    ).toThrow(/tenant\.scope_violation/);
  });

  it('propagates persona denials when no --mission-root is given', () => {
    const sameCheckoutOut = `${pathResolver.rootDir()}/active/missions/public/MSN-X/evidence/docs-sync-report.md`;
    expect(() =>
      writeDocsImpactReport(sameCheckoutOut, undefined, 'report body', {
        writeFile: () => {
          throw new Error(
            "[POLICY_VIOLATION] Persona 'check_docs_impact' is NOT authorized to write to 'x'."
          );
        },
      })
    ).toThrow(/POLICY_VIOLATION/);
  });
});
