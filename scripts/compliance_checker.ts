import * as path from 'node:path';
import { 
  pathResolver, 
  validateReadPermission, 
  validateWritePermission, 
  scanForConfidentialMarkers,
  logger
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('dir', { type: 'string', demandOption: true, describe: 'Directory to scan for compliance' })
    .option('tier', { type: 'string', choices: ['public', 'confidential', 'personal'], default: 'public', describe: 'Target tier for the files' })
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
      const content = (await import('node:fs')).readFileSync(file, 'utf8');
      const scan = scanForConfidentialMarkers(content);
      if (scan.hasMarkers) {
        violations.push(`[CONTENT_VIOLATION] ${file}: Detected sensitive markers: ${scan.markers.join(', ')}`);
      }
    } catch (err) {
      // Skip non-text files or read errors
    }
  }

  if (violations.length > 0) {
    console.log(JSON.stringify({ status: 'failed', violations }, null, 2));
    process.exit(1);
  } else {
    console.log(JSON.stringify({ status: 'passed' }, null, 2));
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
