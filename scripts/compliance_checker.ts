import * as path from 'node:path';
import { validateWritePermission, scanForConfidentialMarkers } from '@agent/core/tier-guard';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import yargs from 'yargs';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function readComplianceTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export async function runComplianceScan(args: string[] = []): Promise<{
  status: 'passed' | 'failed';
  violations: string[];
}> {
  const argv = await yargs(args)
    .option('dir', {
      type: 'string',
      demandOption: true,
      describe: 'Directory to scan for compliance',
    })
    .option('tier', {
      type: 'string',
      choices: ['public', 'confidential', 'personal'],
      default: 'public',
      describe: 'Target tier for the files',
    })
    .parse();

  const targetDir = path.resolve(process.cwd(), argv.dir);
  const files = getAllFiles(targetDir);
  const violations: string[] = [];

  for (const file of files) {
    // 1. Check Path-based Policy
    const writeCheck = validateWritePermission(file);
    if (!writeCheck.allowed) {
      violations.push(`[PATH_VIOLATION] ${file}: ${writeCheck.reason}`);
    }

    // 2. Check Content-based Markers (PII, Secrets, Confidentiality)
    try {
      const content = readComplianceTextFile(file);
      const scan = scanForConfidentialMarkers(content);
      if (scan.hasMarkers) {
        violations.push(
          `[CONTENT_VIOLATION] ${file}: Detected sensitive markers: ${scan.markers.join(', ')}`
        );
      }
    } catch (err) {
      // Skip non-text files or read errors
    }
  }

  if (violations.length > 0) {
    return { status: 'failed', violations };
  }
  return { status: 'passed', violations: [] };
}

if (
  isDirectScript(import.meta.url, 'compliance_checker.ts') ||
  isDirectScript(import.meta.url, 'compliance_checker.js')
) {
  void defineScript({
    name: 'compliance:check',
    flags: [],
    async run({ argv, print }) {
      const result = await runComplianceScan(argv);
      print(result);
      if (result.status === 'failed')
        throw new ScriptExitError(1, 'Compliance violations detected');
    },
  })();
}
