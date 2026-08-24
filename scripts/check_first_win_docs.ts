import { pathResolver, safeReadFile } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

export const FIRST_WIN_DOCS = [
  'README.md',
  'docs/QUICKSTART.md',
  'docs/INITIALIZATION.md',
] as const;

export const FIRST_WIN_COMMANDS = [
  'pnpm install',
  'pnpm build',
  'pnpm prereq:check',
  'pnpm doctor',
  'pnpm pipeline --input pipelines/verify-session.json',
] as const;

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

function fenceIsBalanced(markdown: string): boolean {
  let open = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*```(?:\w+)?\s*$/.test(line)) continue;
    open = !open;
  }
  return !open;
}

function extractFirstWinCommands(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const marker = lines.findIndex((line) => line.trim() === '# kyberion-first-win');
  if (marker < 0) return [];
  const openingFence = lines.findIndex(
    (line, index) => index > marker && /^\s*```bash\s*$/.test(line)
  );
  if (openingFence < 0) return [];
  const commands: string[] = [];
  for (const line of lines.slice(openingFence + 1)) {
    if (/^\s*```\s*$/.test(line)) break;
    const command = line.replace(/\s+#.*$/, '').trim();
    if (command && !command.startsWith('#')) commands.push(command);
  }
  return commands;
}

export function checkFirstWinDocs(): string[] {
  const failures: string[] = [];
  const extracted = new Map<string, string[]>();
  for (const relativePath of FIRST_WIN_DOCS) {
    const markdown = read(relativePath);
    if (!fenceIsBalanced(markdown)) failures.push(`${relativePath}: unbalanced markdown fence`);
    const commands = extractFirstWinCommands(markdown);
    extracted.set(relativePath, commands);
    if (commands.join('\n') !== FIRST_WIN_COMMANDS.join('\n')) {
      failures.push(
        `${relativePath}: first-win commands differ from canonical sequence (${commands.join(' -> ')})`
      );
    }
  }
  if (!read('README.md').includes('docs/QUICKSTART.md')) {
    failures.push('README.md: must link to canonical docs/QUICKSTART.md');
  }
  if (!read('docs/INITIALIZATION.md').includes('QUICKSTART.md')) {
    failures.push('docs/INITIALIZATION.md: must link to canonical QUICKSTART.md');
  }
  return failures;
}

export const runCheckFirstWinDocs = defineScript({
  name: 'check:first-win-docs',
  run(context) {
    const failures = checkFirstWinDocs();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
    context.print(`[check:first-win-docs] OK (${FIRST_WIN_DOCS.length} documents)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_first_win_docs.ts') ||
  isDirectScript(import.meta.url, 'check_first_win_docs.js')
)
  void runCheckFirstWinDocs();
