import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export type DesignNoteStatus = 'proposed' | 'implemented' | 'rejected';

export interface DesignLedgerViolation {
  file: string;
  message: string;
}

const DESIGN_NOTE_STATUSES: readonly DesignNoteStatus[] = ['proposed', 'implemented', 'rejected'];

const REQUIRED_NOTE_FIELDS = ['title', 'status', 'decision_date', 'scope', 'decision'] as const;
const REQUIRED_POSTMORTEM_FIELDS = [
  'incident',
  'impact',
  'trace_or_example',
  'root_cause',
  'prevention',
] as const;

export function readDesignLedgerTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^['"]|['"]$/gu, '');
  }
  return fields;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function collectMarkdownFiles(root: string): string[] {
  if (!safeExistsSync(root) || !safeStat(root).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of safeReaddir(root).sort()) {
    if (entry.startsWith('.')) continue;
    const absolute = path.join(root, entry);
    const stat = safeStat(absolute);
    if (stat.isDirectory()) files.push(...collectMarkdownFiles(absolute));
    else if (stat.isFile() && entry.endsWith('.md')) files.push(absolute);
  }
  return files;
}

function relative(file: string): string {
  return path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
}

function validateRequiredFields(
  file: string,
  fields: Record<string, string>,
  required: readonly string[],
  violations: DesignLedgerViolation[]
): void {
  for (const field of required) {
    if (!isNonEmpty(fields[field])) {
      violations.push({ file, message: `missing non-empty frontmatter field "${field}"` });
    }
  }
}

export function validateDesignLedger(root = pathResolver.rootDir()): DesignLedgerViolation[] {
  const violations: DesignLedgerViolation[] = [];
  const notesRoot = path.join(root, 'docs/developer/design-notes');
  for (const status of DESIGN_NOTE_STATUSES) {
    const statusRoot = path.join(notesRoot, status);
    for (const filePath of collectMarkdownFiles(statusRoot)) {
      const file = relative(filePath);
      const fields = parseFrontmatter(readDesignLedgerTextFile(filePath));
      if (!fields) {
        violations.push({ file, message: 'missing or malformed YAML frontmatter' });
        continue;
      }
      validateRequiredFields(file, fields, REQUIRED_NOTE_FIELDS, violations);
      if (fields.status !== status) {
        violations.push({ file, message: `frontmatter status must be "${status}"` });
      }
      if (status === 'implemented' && !isNonEmpty(fields.evidence)) {
        violations.push({ file, message: 'implemented note requires non-empty "evidence"' });
      }
      if (status === 'rejected' && !isNonEmpty(fields.rationale)) {
        violations.push({ file, message: 'rejected note requires non-empty "rationale"' });
      }
    }
  }

  const postmortemRoot = path.join(root, 'docs/developer/postmortem');
  for (const filePath of collectMarkdownFiles(postmortemRoot)) {
    const file = relative(filePath);
    const fields = parseFrontmatter(readDesignLedgerTextFile(filePath));
    if (!fields) {
      violations.push({ file, message: 'missing or malformed YAML frontmatter' });
      continue;
    }
    validateRequiredFields(file, fields, REQUIRED_POSTMORTEM_FIELDS, violations);
  }
  return violations;
}

export const runCheckDesignLedger = defineScript({
  name: 'check:design-ledger',
  flags: [],
  run(context) {
    const violations = validateDesignLedger();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'violations detected:',
          ...violations.map((violation) => `- ${violation.file}: ${violation.message}`),
        ].join('\n')
      );
    }
    context.print('[check:design-ledger] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_design_ledger.ts') ||
  isDirectScript(import.meta.url, 'check_design_ledger.js')
)
  void runCheckDesignLedger();
