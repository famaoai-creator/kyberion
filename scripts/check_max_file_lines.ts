import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { loadMaxFileLinesConfig, type MaxFileLinesConfig } from '@agent/core/max-file-lines-config';
import { maskComments } from './check_module_boundaries.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const ROOT = pathResolver.rootDir();

function relative(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function isSource(filePath: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/.test(filePath) &&
    !filePath.endsWith('.d.ts') &&
    !filePath.endsWith('.generated.ts') &&
    !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(filePath) &&
    !filePath.includes(`${path.sep}dist${path.sep}`) &&
    !filePath.includes(`${path.sep}.next${path.sep}`)
  );
}

export function checkMaxFileLines(): { maxLines: number; violations: string[] } {
  const config: MaxFileLinesConfig = loadMaxFileLinesConfig();
  const exceptions = new Set(config.exceptions.map((entry) => entry.file));
  const violations: string[] = [];
  if (exceptions.size !== config.exceptions.length) {
    violations.push('max-file-lines: exception files must be unique');
  }
  for (const exception of config.exceptions) {
    if (!exception.file.trim() || !exception.reason.trim() || !exception.target.trim()) {
      violations.push(
        `max-file-lines: every exception must declare file, reason, and target (${exception.file || '<missing>'})`
      );
    }
    if (!safeExistsSync(pathResolver.rootResolve(exception.file))) {
      violations.push(`max-file-lines: exception file does not exist (${exception.file})`);
    }
  }
  for (const root of config.roots) {
    for (const file of getAllFiles(pathResolver.rootResolve(root))) {
      const repoPath = relative(file);
      if (!isSource(file) || exceptions.has(repoPath)) continue;
      const lineCount = maskComments(String(safeReadFile(file, { encoding: 'utf8' })))
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0).length;
      if (lineCount > config.max_lines) {
        violations.push(`${repoPath}: ${lineCount} lines (max ${config.max_lines})`);
      }
    }
  }
  return { maxLines: config.max_lines, violations: violations.sort() };
}

export const runCheckMaxFileLines = defineScript({
  name: 'check:max-file-lines',
  flags: [],
  run(context) {
    const report = checkMaxFileLines();
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...report.violations.map((violation) => `- ${violation}`)].join(
          '\n'
        )
      );
    }
    context.print(`[check:max-file-lines] OK (max ${report.maxLines} lines)`);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_max_file_lines.ts') ||
  isDirectScript(import.meta.url, 'check_max_file_lines.js')
)
  void runCheckMaxFileLines();
