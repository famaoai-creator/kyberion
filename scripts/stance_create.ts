#!/usr/bin/env node
import * as path from 'node:path';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '@agent/core/secure-io';
import { stanceDirForSlug } from '@agent/core/stance-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

/** Repository-relative template copied into a new stance. */
export const STANCE_TEMPLATE_DIR = path.join('templates', 'stance');

function rootDir(): string {
  return pathResolver.rootDir();
}

function templateRoot(): string {
  const resolvedRoot = rootDir();
  return assertSafeRepositoryPath(path.join(resolvedRoot, STANCE_TEMPLATE_DIR), {
    allowMissingLeaf: true,
    rootDir: resolvedRoot,
  });
}

function isDirectoryEmpty(dir: string): boolean {
  return safeReaddir(dir).length === 0;
}

function copyTree(srcDir: string, dstDir: string): void {
  const resolvedRoot = rootDir();
  const safeSourceDir = assertSafeRepositoryPath(srcDir, { rootDir: resolvedRoot });
  const safeDestinationDir = assertSafeRepositoryPath(dstDir, {
    allowMissingLeaf: true,
    rootDir: resolvedRoot,
  });
  safeMkdir(safeDestinationDir, { recursive: true });
  for (const entry of safeReaddir(safeSourceDir)) {
    const src = assertSafeRepositoryPath(path.join(safeSourceDir, entry), {
      rootDir: resolvedRoot,
    });
    const dst = assertSafeRepositoryPath(path.join(safeDestinationDir, entry), {
      allowMissingLeaf: true,
      rootDir: resolvedRoot,
    });
    const stat = safeLstat(src);
    if (stat.isDirectory()) {
      copyTree(src, dst);
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlink from template: ${path.relative(rootDir(), src)}`);
    }
    safeCopyFileSync(src, dst);
  }
}

/** Create `knowledge/personal/stances/{slug}/` from the stance template. */
export function createStance(slugInput: string): {
  slug: string;
  root: string;
  template: string;
} {
  const slug = slugInput.trim();
  const dest = stanceDirForSlug(slug, rootDir());
  const template = templateRoot();
  if (!safeExistsSync(template) || !safeLstat(template).isDirectory()) {
    throw new Error(`Stance template not found: ${path.relative(rootDir(), template)}`);
  }
  if (safeExistsSync(dest) && !isDirectoryEmpty(dest)) {
    throw new Error(
      `Stance directory already exists and is not empty: ${path.relative(rootDir(), dest)}`
    );
  }
  copyTree(template, dest);
  return { slug, root: dest, template };
}

export function formatCreatedStance(root: string): string[] {
  return [`Created stance at ${path.relative(rootDir(), root)}`];
}

export function main(argv: string[], print: Print = () => undefined): string[] {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: stance_create <slug>';
    if (slug) {
      print(usage);
      throw new ScriptExitError(0, '', true);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const created = createStance(slug);
    return formatCreatedStance(created.root);
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'stance_create.ts') ||
  isDirectScript(import.meta.url, 'stance_create.js')
)
  void defineScript({
    name: 'stance:create',
    flags: [],
    run(context) {
      context.print(main(context.argv, context.print).join('\n'));
    },
  })();
