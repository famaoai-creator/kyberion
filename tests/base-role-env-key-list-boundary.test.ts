import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeExistsSync } from '@agent/core/secure-io';
import {
  BASE_ROLE_ENV,
  LEGACY_PERSONA_ENV,
  baseRoleEnvText,
  writeBaseRoleEnv,
  __baseRoleEnvTest__,
} from '@agent/core/foundation';
import { productSourceFiles } from './helpers/store-grant-boundary.js';

// S4 slice 4 (ADR concept-model-v2 D5): KYBERION_PERSONA is the retired name of
// KYBERION_BASE_ROLE, read for one release only when the new name is absent.
// A child-process env key list (pass or strip) that names one without the other
// lets a child fall back to a different base role than its parent meant:
// stripping only the new name leaves an inherited legacy value; passing only the
// new name drops an operator's explicit legacy value and the child falls back
// to its role's default base role, which can be wider. Outside those lists the
// legacy name is read in exactly one place (foundation/base-role-env.ts).

const ROOT = process.cwd();
const BOTH = [BASE_ROLE_ENV, LEGACY_PERSONA_ENV] as const;

/** Files that may name the legacy variable outside a paired list or env literal. */
const LEGACY_NAME_ALLOWED = new Set([
  // the reader and its constants
  'libs/core/foundation/base-role-env.ts',
  // generated from env-registry.json (the deprecated entry)
  'libs/core/foundation/config.generated.ts',
  // `.env.local` written by an earlier onboarding is still read for one release
  'scripts/reasoning/reasoning_backend_selection.ts',
]);

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

interface Finding {
  file: string;
  line: number;
  problem: string;
}

/** Element names of an array literal, or key names of an object literal. */
function listedNames(container: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression): string[] {
  if (ts.isArrayLiteralExpression(container)) {
    return container.elements.map((element) => nameOf(element) ?? '').filter(Boolean);
  }
  return container.properties
    .map((property) => (property.name ? (nameOf(property.name) ?? '') : ''))
    .filter(Boolean);
}

export function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const allowed = LEGACY_NAME_ALLOWED.has(file);
  const report = (node: ts.Node, problem: string) =>
    findings.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      problem,
    });
  const visit = (node: ts.Node): void => {
    const name = ts.isStringLiteralLike(node) || ts.isIdentifier(node) ? nameOf(node) : undefined;
    if (name === BASE_ROLE_ENV || name === LEGACY_PERSONA_ENV) {
      const parent = node.parent;
      const inArray = parent && ts.isArrayLiteralExpression(parent);
      const asKey =
        parent &&
        (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
        parent.name === node &&
        ts.isObjectLiteralExpression(parent.parent);
      if (inArray) {
        const names = listedNames(parent);
        const missing = BOTH.filter((entry) => !names.includes(entry));
        if (missing.length > 0)
          report(node, `key list names ${name} without ${missing.join(', ')}`);
      } else if (asKey && name === LEGACY_PERSONA_ENV) {
        const names = listedNames(parent.parent as ts.ObjectLiteralExpression);
        if (!names.includes(BASE_ROLE_ENV))
          report(node, `env literal sets ${LEGACY_PERSONA_ENV} without ${BASE_ROLE_ENV}`);
      } else if (name === LEGACY_PERSONA_ENV && !allowed) {
        const isDelete =
          parent &&
          ts.isPropertyAccessExpression(parent) &&
          parent.parent &&
          ts.isDeleteExpression(parent.parent);
        if (!isDelete) report(node, `reads or writes ${LEGACY_PERSONA_ENV} outside base-role-env`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function configFiles(): string[] {
  const out: string[] = ['package.json'];
  const workflows = path.join(ROOT, '.github', 'workflows');
  for (const entry of safeReaddir(workflows))
    if (/\.ya?ml$/u.test(entry)) out.push(`.github/workflows/${entry}`);
  for (const dir of [
    'pipelines',
    'plugins',
    'knowledge/product/governance',
    'knowledge/product/pipeline-templates',
  ]) {
    const absolute = path.join(ROOT, dir);
    if (!safeExistsSync(absolute)) continue;
    for (const file of getAllFiles(absolute))
      if (/\.(?:json|ya?ml)$/u.test(file) && !/\/node_modules\//u.test(file))
        out.push(relative(file));
  }
  return out;
}

/** Registries that describe the retired name itself. */
const CONFIG_LEGACY_ALLOWED = new Set([
  'knowledge/product/governance/env-registry.json',
  'knowledge/product/governance/concept-registry.json',
]);

describe('KYBERION_BASE_ROLE / KYBERION_PERSONA key lists (S4 slice 4)', () => {
  it('every product source names both or reads through base-role-env', () => {
    const findings = productSourceFiles().flatMap((file) => {
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      if (!text.includes(LEGACY_PERSONA_ENV) && !text.includes(BASE_ROLE_ENV)) return [];
      return scanSource(relative(file), text);
    });
    expect(findings).toEqual([]);
  });

  it('no launch configuration, workflow or pipeline sets the retired name', () => {
    const offenders = configFiles().filter((file) => {
      if (CONFIG_LEGACY_ALLOWED.has(file)) return false;
      const text = safeReadFile(path.join(ROOT, file), { encoding: 'utf8' }) as string;
      return /KYBERION_PERSONA(?![A-Z_])/u.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('flags a list that strips or passes only one of the names', () => {
    expect(scanSource('x.ts', `const A = ['MISSION_ROLE', 'KYBERION_PERSONA'];`)).toHaveLength(1);
    expect(scanSource('x.ts', `const A = ['MISSION_ROLE', 'KYBERION_BASE_ROLE'];`)).toHaveLength(1);
    expect(
      scanSource('x.ts', `const A = ['KYBERION_BASE_ROLE', 'KYBERION_PERSONA'];`)
    ).toHaveLength(0);
    expect(scanSource('x.ts', `const env = { KYBERION_PERSONA: '' };`)).toHaveLength(1);
    expect(
      scanSource('x.ts', `const env = { KYBERION_BASE_ROLE: '', KYBERION_PERSONA: '' };`)
    ).toHaveLength(0);
    expect(scanSource('x.ts', `const env = { KYBERION_BASE_ROLE: 'worker' };`)).toHaveLength(0);
    expect(scanSource('x.ts', `read('KYBERION_PERSONA');`)).toHaveLength(1);
  });
});

describe('base-role-env alias semantics', () => {
  it('reads the new name first; an empty new name never falls back to the legacy one', () => {
    expect(baseRoleEnvText({ KYBERION_BASE_ROLE: 'worker', KYBERION_PERSONA: 'sovereign' })).toBe(
      'worker'
    );
    expect(baseRoleEnvText({ KYBERION_BASE_ROLE: '', KYBERION_PERSONA: 'sovereign' })).toBe(
      undefined
    );
    expect(baseRoleEnvText({ KYBERION_BASE_ROLE: 'base_analyst' })).toBe('analyst');
    expect(baseRoleEnvText({})).toBe(undefined);
  });

  it('reads the legacy name only when the new one is absent, unchanged', () => {
    __baseRoleEnvTest__.resetLegacyWarning();
    expect(baseRoleEnvText({ KYBERION_PERSONA: 'worker' })).toBe('worker');
    // the legacy value is not normalised (it was never a card name)
    expect(baseRoleEnvText({ KYBERION_PERSONA: 'base_worker' })).toBe('base_worker');
  });

  it('writes only the new name and drops the legacy one', () => {
    const env: Record<string, string | undefined> = { KYBERION_PERSONA: 'sovereign' };
    writeBaseRoleEnv(env, 'worker');
    expect(env).toEqual({ KYBERION_BASE_ROLE: 'worker' });
    const cleared: Record<string, string | undefined> = { KYBERION_PERSONA: 'sovereign' };
    writeBaseRoleEnv(cleared, null);
    expect(cleared).toEqual({ KYBERION_BASE_ROLE: '' });
    expect(baseRoleEnvText(cleared)).toBe(undefined);
  });
});
