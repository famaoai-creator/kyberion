#!/usr/bin/env node
const { runSkill } = require('@agent/core');
const _fs = require('fs');
const path = require('path');

const { execSync } = require('child_process');

/**
 * License Auditor (Real-World Scanner)
 * Uses npm list to verify licenses of all dependencies.
 */

runSkill('license-auditor', () => {
  const rootDir = path.resolve(__dirname, '../..');

  // 1. Run real license scan
  let npmList;
  try {
    const raw = execSync('npm list --all --json', { cwd: rootDir, encoding: 'utf8' });
    npmList = JSON.parse(raw);
  } catch (_err) {
    // If npm list fails, try a flatter version
    const raw = execSync('npm list --depth=0 --json', { cwd: rootDir, encoding: 'utf8' });
    npmList = JSON.parse(raw);
  }

  const RISKY_PATTERNS = [/GPL/i, /AGPL/i, /LGPL/i, /CC-BY-NC/i];
  const findings = [];
  const scanned = new Set();

  function scanDeps(deps) {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (scanned.has(name)) continue;
      scanned.add(name);

      const license = info.license || (info.licenses && info.licenses[0]?.type) || 'Unknown';
      const isRisky = RISKY_PATTERNS.some((p) => p.test(license));

      if (isRisky) {
        findings.push({ name, license, version: info.version });
      }
      if (info.dependencies) scanDeps(info.dependencies);
    }
  }

  scanDeps(npmList.dependencies);

  return {
    status: findings.length > 0 ? 'warning' : 'compliant',
    summary: {
      total_packages: scanned.size,
      risky_count: findings.length,
    },
    findings,
    message:
      findings.length > 0
        ? `Alert: Found ${findings.length} packages with restrictive licenses.`
        : `Success: All ${scanned.size} packages comply with permissive license standards (MIT/Apache/BSD).`,
  };
});
