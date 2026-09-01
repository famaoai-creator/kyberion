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
  safeWriteFile,
} from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import { createCustomer } from './customer_create.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function copyTree(srcDir: string, dstDir: string): void {
  const rootDir = pathResolver.rootDir();
  const safeSourceDir = assertSafeRepositoryPath(srcDir, { rootDir });
  const safeDestinationDir = assertSafeRepositoryPath(dstDir, {
    allowMissingLeaf: true,
    rootDir,
  });
  safeMkdir(safeDestinationDir, { recursive: true });
  for (const entry of safeReaddir(safeSourceDir)) {
    const src = assertSafeRepositoryPath(path.join(safeSourceDir, entry), { rootDir });
    const dst = assertSafeRepositoryPath(path.join(safeDestinationDir, entry), {
      allowMissingLeaf: true,
      rootDir,
    });
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
  const rootDir = pathResolver.rootDir();
  const personalRoot = assertSafeRepositoryPath(pathResolver.knowledge('personal'), {
    rootDir,
  });
  const customerRoot = created.root;

  const customerJsonPath = assertSafeRepositoryPath(path.join(customerRoot, 'customer.json'), {
    allowMissingLeaf: true,
    rootDir,
  });
  const customerJson = readJson<Record<string, unknown>>(customerJsonPath);
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
      const safeSource = assertSafeRepositoryPath(src, { rootDir });
      if (!safeLstat(safeSource).isFile()) {
        throw new Error(`Refusing to migrate non-file personal resource: ${srcName}`);
      }
      safeCopyFileSync(
        safeSource,
        assertSafeRepositoryPath(path.join(customerRoot, dstName), {
          allowMissingLeaf: true,
          rootDir,
        })
      );
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

export function formatMigratedCustomer(root: string): string[] {
  return [`Migrated personal setup to ${path.relative(pathResolver.rootDir(), root)}`];
}

function main(argv: string[]): string[] {
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
    return formatMigratedCustomer(customerRoot);
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
      context.print(main(context.argv).join('\n'));
    },
  })();
