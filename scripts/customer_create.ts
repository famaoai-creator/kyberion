#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyError,
  formatClassification,
  pathResolver,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '@agent/core';

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
  return path.join(rootDir(), 'customer', slug);
}

function templateRoot(): string {
  return path.join(rootDir(), 'customer', '_template');
}

function isDirectoryEmpty(dir: string): boolean {
  return safeReaddir(dir).length === 0;
}

function copyTree(srcDir: string, dstDir: string): void {
  safeMkdir(dstDir, { recursive: true });
  for (const entry of safeReaddir(srcDir)) {
    const src = path.join(srcDir, entry);
    const dst = path.join(dstDir, entry);
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

export function createCustomer(slugInput: string): { slug: string; root: string; template: string } {
  const slug = validateSlug(slugInput);
  const template = templateRoot();
  if (!safeExistsSync(template) || !safeLstat(template).isDirectory()) {
    throw new Error(`Customer template not found: ${path.relative(rootDir(), template)}`);
  }

  const dest = customerRoot(slug);
  if (safeExistsSync(dest) && !isDirectoryEmpty(dest)) {
    throw new Error(`Customer directory already exists and is not empty: ${path.relative(rootDir(), dest)}`);
  }

  copyTree(template, dest);
  return { slug, root: dest, template };
}

function main(): void {
  const slug = process.argv[2];
  if (!slug || slug === '--help' || slug === '-h') {
    console.error('Usage: customer_create <slug>');
    process.exit(slug ? 0 : 2);
  }

  try {
    const created = createCustomer(slug);
    console.log(`Created customer template at ${path.relative(rootDir(), created.root)}`);
  } catch (err) {
    console.error(formatClassification(classifyError(err)));
    process.exit(1);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
