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
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core';
import { createCustomer } from './customer_create.js';

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
      throw new Error(`Refusing to copy symlink from personal tree: ${path.relative(pathResolver.rootDir(), src)}`);
    }
    safeCopyFileSync(src, dst);
  }
}

export function migratePersonalCustomer(slug: string): string {
  const created = createCustomer(slug);
  const personalRoot = pathResolver.knowledge('personal');
  const customerRoot = created.root;

  const customerJsonPath = path.join(customerRoot, 'customer.json');
  const customerJson = JSON.parse(safeReadFile(customerJsonPath, { encoding: 'utf8' }) as string) as Record<string, unknown>;
  safeWriteFile(
    customerJsonPath,
    JSON.stringify(
      {
        ...customerJson,
        slug,
        display_name: customerJson.display_name || slug,
      },
      null,
      2,
    ) + '\n',
  );

  const mappings: Array<[string, string]> = [
    ['my-identity.json', 'identity.json'],
    ['my-vision.md', 'vision.md'],
  ];

  for (const [srcName, dstName] of mappings) {
    const src = path.join(personalRoot, srcName);
    if (safeExistsSync(src)) {
      safeCopyFileSync(src, path.join(customerRoot, dstName));
    }
  }

  for (const dirName of ['connections', 'tenants', 'voice']) {
    const srcDir = path.join(personalRoot, dirName);
    if (safeExistsSync(srcDir) && safeLstat(srcDir).isDirectory()) {
      copyTree(srcDir, path.join(customerRoot, dirName));
    }
  }

  return customerRoot;
}

function main(): void {
  const slug = process.argv[2];
  if (!slug || slug === '--help' || slug === '-h') {
    console.error('Usage: customer_migrate_from_personal <slug>');
    process.exit(slug ? 0 : 2);
  }

  try {
    const customerRoot = migratePersonalCustomer(slug);
    console.log(`Migrated personal setup to ${path.relative(pathResolver.rootDir(), customerRoot)}`);
  } catch (err) {
    console.error(formatClassification(classifyError(err)));
    process.exit(1);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
