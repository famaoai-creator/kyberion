#!/usr/bin/env node
import * as path from 'node:path';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import * as customerResolver from '@agent/core/customer-resolver';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

interface CustomerEntry {
  slug: string;
  path: string;
  active: boolean;
  ready: boolean;
  missing: string[];
}

const REQUIRED_FILES = ['customer.json', 'identity.json', 'vision.md'];

export function listCustomers(): CustomerEntry[] {
  const rootDir = pathResolver.rootDir();
  const customerRoot = assertSafeRepositoryPath(path.join(rootDir, 'customer'), {
    allowMissingLeaf: true,
    rootDir,
  });
  if (!safeExistsSync(customerRoot) || !safeLstat(customerRoot).isDirectory()) {
    return [];
  }

  const current = customerResolver.activeCustomer() ?? null;
  const entries: CustomerEntry[] = [];

  for (const entry of safeReaddir(customerRoot).sort()) {
    if (entry === 'README.md' || entry === '_template') continue;
    const full = assertSafeRepositoryPath(path.join(customerRoot, entry), {
      allowMissingLeaf: true,
      rootDir,
    });
    if (!safeLstat(full).isDirectory()) continue;
    const missing = REQUIRED_FILES.filter((required) => {
      const requiredPath = path.join(full, required);
      return !safeExistsSync(requiredPath) || !safeLstat(requiredPath).isFile();
    });
    entries.push({
      slug: entry,
      path: path.relative(pathResolver.rootDir(), full),
      active: entry === current,
      ready: missing.length === 0,
      missing,
    });
  }

  return entries;
}

export function printText(entries: CustomerEntry[]): string[] {
  if (entries.length === 0) {
    return ['No customer overlays found.'];
  }

  return entries.map((entry) => {
    const status = entry.ready ? 'ready' : `missing ${entry.missing.join(', ')}`;
    return `${entry.active ? '* ' : '  '}${entry.slug}\t${status}\t${entry.path}`;
  });
}

export const main = defineScript({
  name: 'customer:list',
  flags: ['json'],
  run(context) {
    try {
      const entries = listCustomers();
      if (context.json) context.print(entries);
      else context.print(printText(entries).join('\n'));
    } catch (err) {
      throw new Error(formatClassification(classifyError(err)));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'customer_list.ts') ||
  isDirectScript(import.meta.url, 'customer_list.js')
) {
  void main();
}
