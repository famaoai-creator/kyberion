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
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class InvalidCustomerSlugError extends Error {
  constructor(slug: string) {
    super(`Invalid customer slug: "${slug}". Must match ${SLUG_PATTERN.source}.`);
    this.name = 'InvalidCustomerSlugError';
  }
}

function validateSlug(slug: string): string {
  const normalized = slug.trim();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new InvalidCustomerSlugError(slug);
  }
  return normalized;
}

function rootDir(): string {
  return pathResolver.rootDir();
}

function customerRoot(slug: string): string {
  const resolvedRoot = rootDir();
  return assertSafeRepositoryPath(path.join(resolvedRoot, 'customer', slug), {
    allowMissingLeaf: true,
    rootDir: resolvedRoot,
  });
}

function templateRoot(): string {
  const resolvedRoot = rootDir();
  return assertSafeRepositoryPath(path.join(resolvedRoot, 'customer', '_template'), {
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

export function createCustomer(slugInput: string): {
  slug: string;
  root: string;
  template: string;
} {
  const slug = validateSlug(slugInput);
  const template = templateRoot();
  if (!safeExistsSync(template) || !safeLstat(template).isDirectory()) {
    throw new Error(`Customer template not found: ${path.relative(rootDir(), template)}`);
  }

  const dest = customerRoot(slug);
  if (safeExistsSync(dest) && !isDirectoryEmpty(dest)) {
    throw new Error(
      `Customer directory already exists and is not empty: ${path.relative(rootDir(), dest)}`
    );
  }

  copyTree(template, dest);
  return { slug, root: dest, template };
}

export function formatCreatedCustomer(root: string): string[] {
  return [`Created customer template at ${path.relative(rootDir(), root)}`];
}

export function main(argv: string[], print: Print = () => undefined): string[] {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: customer_create <slug>';
    if (slug) {
      print(usage);
      throw new ScriptExitError(0, '', true);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const created = createCustomer(slug);
    return formatCreatedCustomer(created.root);
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'customer_create.ts') ||
  isDirectScript(import.meta.url, 'customer_create.js')
)
  void defineScript({
    name: 'customer:create',
    flags: [],
    run(context) {
      context.print(main(context.argv, context.print).join('\n'));
    },
  })();
