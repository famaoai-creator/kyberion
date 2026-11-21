import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import {
  createPresenceScaffold,
  parsePresenceTarget,
  planPresenceScaffold,
} from './create_presence.js';

const WIRED = [
  'tsconfig.json',
  'tsconfig.packages.json',
  'scripts/build-output-layout.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/cross-os.yml',
  '.github/workflows/pr-validation.yml',
  'knowledge/product/governance/i18n-baseline.json',
];

const text = (file: string) => String(safeReadFile(file, { encoding: 'utf8' }));

describe('create presence', () => {
  const root = pathResolver.sharedTmp('create-presence-tests');

  beforeEach(() => {
    // A copy of the real wiring files, so the anchors under test are the live ones.
    for (const file of WIRED) {
      const target = path.join(root, file);
      safeMkdir(path.dirname(target), { recursive: true });
      safeWriteFile(target, text(pathResolver.rootResolve(file)));
    }
  });
  afterEach(() => safeRmSync(root, { recursive: true, force: true }));

  it('accepts only workspace groups and kebab names', () => {
    expect(parsePresenceTarget('displays/ops-board')).toEqual({
      group: 'displays',
      name: 'ops-board',
    });
    for (const bad of ['sensors/x1', 'displays/Ops', 'displays/x', 'ops-board', 'displays/a-'])
      expect(() => parsePresenceTarget(bad)).toThrow(/Usage/);
  });

  it('writes the package and every registration in one step', () => {
    const result = createPresenceScaffold({
      target: 'displays/ops-board',
      description: 'Ops board',
      rootDir: root,
    });
    expect(result.packageName).toBe('@presence/ops-board');
    expect(result.created).toContain('presence/displays/ops-board/src/index.test.ts');
    expect(result.updated.sort()).toEqual([...WIRED].sort());

    const id = 'presence/displays/ops-board';
    const tsconfig = JSON.parse(text(path.join(root, 'tsconfig.json')));
    expect(tsconfig.exclude).toContain(`${id}/`);
    expect(tsconfig.references).toContainEqual({ path: `./${id}` });
    expect(JSON.parse(text(path.join(root, 'tsconfig.packages.json'))).references).toContainEqual({
      path: `./${id}`,
    });
    const layout = text(path.join(root, 'scripts/build-output-layout.ts'));
    expect(layout).toContain(`    id: '${id}',\n    sourceRoot: '${id}/src',\n`);
    expect(layout).toMatch(
      /ROOT_SOURCE_EXCLUSIONS = \{\n {2}presence: \[[^\]]*'displays\/ops-board',/u
    );
    for (const workflow of WIRED.filter((f) => f.endsWith('.yml')))
      expect(text(path.join(root, workflow))).toContain(`            ${id}/dist/\n`);
    expect(
      JSON.parse(text(path.join(root, 'knowledge/product/governance/i18n-baseline.json')))
        .scan_roots
    ).toContain(id);
    const pkg = JSON.parse(text(path.join(root, id, 'package.json')));
    expect(pkg).toMatchObject({
      name: '@presence/ops-board',
      dependencies: { '@agent/core': 'workspace:*' },
    });
    expect(result.nextSteps.join('\n')).toMatch(/PI_LOCKFILE_REVIEW_EVIDENCE/);
  });

  it('is idempotent on the wiring and refuses an existing package', () => {
    createPresenceScaffold({ target: 'bridge/relay-x', rootDir: root });
    expect(() => planPresenceScaffold({ target: 'bridge/relay-x', rootDir: root })).toThrow(
      /already exists/
    );
    safeRmSync(path.join(root, 'presence'), { recursive: true, force: true });
    const again = planPresenceScaffold({ target: 'bridge/relay-x', rootDir: root });
    expect(Object.keys(again.updated)).toEqual([]);
    expect(again.unchanged.sort()).toEqual([...WIRED].sort());
  });

  it('refuses a package name another workspace package already uses', () => {
    expect(() =>
      planPresenceScaffold({
        target: 'displays/terminal',
        rootDir: root,
        workspacePackages: [{ name: '@presence/terminal', dir: 'presence/bridge/terminal' }],
      })
    ).toThrow(/@presence\/terminal is already the name of presence\/bridge\/terminal/);
    // the real workspace is consulted by default
    expect(() => planPresenceScaffold({ target: 'bridge/mission-deck', rootDir: root })).toThrow(
      /already the name of/
    );
  });

  it('writes the build-output entry the way prettier prints it', () => {
    createPresenceScaffold({ target: 'displays/ops-board', rootDir: root });
    expect(text(path.join(root, 'scripts/build-output-layout.ts'))).toContain(
      "  {\n    id: 'presence/displays/ops-board',\n    sourceRoot: 'presence/displays/ops-board/src',\n    excludeTests: true,\n  },\n] as const;"
    );
  });

  it('changes nothing when an anchor is missing', () => {
    const workflow = path.join(root, '.github/workflows/cross-os.yml');
    safeWriteFile(workflow, text(workflow).replace(/^\s*plugins\/dist\/\n/mu, ''));
    const before = text(path.join(root, 'tsconfig.json'));
    expect(() => createPresenceScaffold({ target: 'displays/ops-board', rootDir: root })).toThrow(
      /cross-os\.yml: line "plugins\/dist\/" not found/
    );
    expect(text(path.join(root, 'tsconfig.json'))).toBe(before);
    expect(safeExistsSync(path.join(root, 'presence/displays/ops-board'))).toBe(false);
  });
});
