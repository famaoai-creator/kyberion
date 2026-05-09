#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyError,
  formatClassification,
  customerResolver,
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core';

interface CustomerEntry {
  slug: string;
  path: string;
  active: boolean;
  ready: boolean;
  missing: string[];
}

const REQUIRED_FILES = ['customer.json', 'identity.json', 'vision.md'];

export function listCustomers(): CustomerEntry[] {
  const customerRoot = path.join(pathResolver.rootDir(), 'customer');
  if (!safeExistsSync(customerRoot) || !safeLstat(customerRoot).isDirectory()) {
    return [];
  }

  const current = customerResolver.activeCustomer() ?? null;
  const entries: CustomerEntry[] = [];

  for (const entry of safeReaddir(customerRoot).sort()) {
    if (entry === 'README.md' || entry === '_template') continue;
    const full = path.join(customerRoot, entry);
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

export function printText(entries: CustomerEntry[]): void {
  if (entries.length === 0) {
    console.log('No customer overlays found.');
    return;
  }

  for (const entry of entries) {
    const status = entry.ready ? 'ready' : `missing ${entry.missing.join(', ')}`;
    console.log(`${entry.active ? '* ' : '  '}${entry.slug}\t${status}\t${entry.path}`);
  }
}

function main(): void {
  const json = process.argv.includes('--json');
  try {
    const entries = listCustomers();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    printText(entries);
  } catch (err) {
    console.error(formatClassification(classifyError(err)));
    process.exit(1);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
