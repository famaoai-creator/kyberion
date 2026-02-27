import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSovereignBoundary, validateWritePermission } from '@agent/core/tier-guard';
import { getAllFiles } from '@agent/core/fs-utils';

export interface AuditConfig {
  audit_name: string;
  exclusions: string[];
  severity_mapping: {
    personal_leak: string;
  };
}

export interface Violation {
  file: string;
  issue: string;
  detected_fragments?: string[];
  severity: string;
  reason?: string;
}

export interface AuditResult {
  status: 'violation_detected' | 'clean';
  audit_name: string;
  total_scanned: number;
  violation_count: number;
  violations: Violation[];
  recommendations: string[];
}

export function performAudit(targetDir: string, config: AuditConfig): AuditResult {
  const files = getAllFiles(targetDir);
  const violations: Violation[] = [];
  let scannedCount = 0;

  files.forEach((file) => {
    const relPath = path.relative(targetDir, file);
    if (config.exclusions.some((pattern) => relPath.includes(pattern.replace('*', '')))) return;

    try {
      const content = fs.readFileSync(file, 'utf8');
      const leakGuard = validateSovereignBoundary(content);

      if (!leakGuard.safe) {
        violations.push({
          file: relPath,
          issue: 'Personal/Confidential tier tokens detected in public knowledge.',
          detected_fragments: leakGuard.detected,
          severity: config.severity_mapping.personal_leak,
        });
      }
    } catch (_e) {
      // Skip binary
    }

    const writeGuard = validateWritePermission(file);
    if (!writeGuard.allowed) {
      violations.push({
        file: relPath,
        issue: 'Access Policy Violation: File located in a tier restricted for the current role.',
        reason: writeGuard.reason,
        severity: 'CRITICAL',
      });
    }

    scannedCount++;
  });

  return {
    status: violations.length > 0 ? 'violation_detected' : 'clean',
    audit_name: config.audit_name,
    total_scanned: scannedCount,
    violation_count: violations.length,
    violations,
    recommendations:
      violations.length > 0
        ? ['Remove sensitive tokens immediately.', 'Check Personal tier for high-entropy strings.']
        : ['Public knowledge base is sovereignty-compliant.'],
  };
}
