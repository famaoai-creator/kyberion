#!/usr/bin/env node
import * as path from 'node:path';
import {
  classifyError,
  formatClassification,
  customerResolver,
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core';
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

export const main = defineScript({
  name: 'customer:list',
  flags: ['json'],
  run(context) {
    try {
      const entries = listCustomers();
      if (context.json) context.print(entries);
      else printText(entries);
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
