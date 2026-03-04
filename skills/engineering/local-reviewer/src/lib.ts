import * as fs from 'node:fs';
import * as path from 'node:path';

import { execSync } from 'node:child_process';

/**
 * Local Reviewer Core Library.
 */

export interface ReviewFinding {
  file: string;
  line: number;
  type: 'style' | 'security' | 'logic';
  message: string;
}

export function getStagedDiff(): string {
  try {
    return execSync('git diff --staged', { encoding: 'utf8' });
  } catch (_) {
    return '';
  }
}

export function reviewFile(filePath: string, content: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    // Simple style checks
    if (line.length > 120) {
      findings.push({ file: filePath, line: lineNum, type: 'style', message: 'Line is too long (> 120 chars)' });
    }
    if (line.includes('TODO')) {
      findings.push({ file: filePath, line: lineNum, type: 'logic', message: 'Unresolved TODO item found' });
    }
    // Simple security
    if (line.includes('eval(')) {
      findings.push({ file: filePath, line: lineNum, type: 'security', message: 'Dangerous use of eval()' });
    }
  });

  return findings;
}
