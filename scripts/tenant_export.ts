#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as backupMain } from './backup.js';

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

export function main(argv = process.argv.slice(2)): void {
  backupMain(translateArgs(argv));
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
