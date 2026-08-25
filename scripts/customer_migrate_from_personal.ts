#!/usr/bin/env node
import * as path from 'node:path';
import {
  classifyError,
  formatClassification,
  loadJson,
  pathResolver,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '@agent/core';
import { createCustomer } from './customer_create.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
      throw new Error(
        `Refusing to copy symlink from personal tree: ${path.relative(pathResolver.rootDir(), src)}`
      );
    }
    safeCopyFileSync(src, dst);
  }
}

export function migratePersonalCustomer(slug: string): string {
  const created = createCustomer(slug);
  const personalRoot = pathResolver.knowledge('personal');
  const customerRoot = created.root;

  const customerJsonPath = path.join(customerRoot, 'customer.json');
  const customerJson = loadJson<Record<string, unknown>>(customerJsonPath);
  safeWriteFile(
    customerJsonPath,
    JSON.stringify(
      {
        ...customerJson,
        slug,
        display_name: customerJson.display_name || slug,
      },
      null,
      2
    ) + '\n'
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

function main(argv: string[]): void {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: customer_migrate_from_personal <slug>';
    if (slug) {
      console.error(usage);
      throw new ScriptExitError(0);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const customerRoot = migratePersonalCustomer(slug);
    console.log(
      `Migrated personal setup to ${path.relative(pathResolver.rootDir(), customerRoot)}`
    );
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'customer_migrate_from_personal.ts') ||
  isDirectScript(import.meta.url, 'customer_migrate_from_personal.js')
)
  void defineScript({
    name: 'customer:migrate-from-personal',
    flags: [],
    run(context) {
      return main(context.argv);
    },
  })();
