#!/usr/bin/env node
/**
 * knowledge-auditor/scripts/audit.cjs
 * Hardened Sovereignty Auditor using @agent/core and tier-guard.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const {
  validateSovereignBoundary,
  validateWritePermission,
} = require('@agent/core/tier-guard');
const { getAllFiles } = require('@agent/core/fs-utils');

runSkill('knowledge-auditor', () => {
  // Robust argument extraction (consistent with updated framework)
  const dirIdx = process.argv.indexOf('--dir');
  const targetDir =
    dirIdx !== -1
      ? path.resolve(process.argv[dirIdx + 1])
      : path.resolve(__dirname, '../../knowledge');

  // 1. Load Knowledge (Audit Config)
  const configPath = path.resolve(
    __dirname,
    '../../knowledge/skills/knowledge-auditor/config.json'
  );
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const files = getAllFiles(targetDir);
  const violations = [];
  let scannedCount = 0;

  // 2. Perform Sovereignty & Structural Audit
  files.forEach((file) => {
    // Skip excluded files/dirs based on config
    const relPath = path.relative(targetDir, file);
    if (config.exclusions.some((pattern) => relPath.includes(pattern.replace('*', '')))) return;

    // --- Content Audit (Leaks) ---
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
      /* Skip binary */
    }

    // --- Structural Audit (Placement Permissions) ---
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
        ? [
            'Remove sensitive tokens from the files above immediately.',
            'Check Personal tier for unintentional high-entropy strings.',
          ]
        : ['Public knowledge base is sovereignty-compliant.'],
  };
});
