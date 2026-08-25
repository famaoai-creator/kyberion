#!/usr/bin/env node
import { main as backupMain } from './backup.js';
import { defineScript, isDirectScript } from './lib/harness.js';

function translateArgs(argv: string[]): string[] {
  const translated = ['create', '--scope', 'tenant'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--customer') {
      translated.push('--tenant', argv[i + 1] || '');
      i += 1;
    } else {
      translated.push(arg);
    }
  }
  if (!translated.includes('--encrypt')) translated.push('--encrypt');
  return translated;
}

export function main(argv: string[] = []): void {
  backupMain(translateArgs(argv));
}

export const runTenantExport = defineScript({
  name: 'tenant:export',
  flags: [],
  run: (context) => main(context.argv),
});

if (
  isDirectScript(import.meta.url, 'tenant_export.ts') ||
  isDirectScript(import.meta.url, 'tenant_export.js')
)
  void runTenantExport();
