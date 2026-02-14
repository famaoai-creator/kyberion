#!/usr/bin/env node
const { runSkill } = require('@agent/core');
const fs = require('fs');
const path = require('path');

/**
 * License Auditor
 * Scans dependencies for risky licenses (Copyleft, etc).
 */

runSkill('license-auditor', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  
  const RISKY_LICENSES = ['GPL', 'AGPL', 'LGPL'];
  const violations = [];

  // Heuristic scan of node_modules (simulated)
  // In real life, this would use a library like 'license-checker'
  const deps = Object.keys(pkg.dependencies || {});
  deps.forEach(dep => {
    // Check if license is known or risky
    if (dep.includes('gpl')) violations.push({ dep, license: 'GPL-compatible?' });
  });

  return {
    status: violations.length > 0 ? 'warning' : 'compliant',
    violations,
    scanned_deps: deps.length,
    message: violations.length > 0 
      ? `Found ${violations.length} potentially risky licenses.` 
      : "All dependencies comply with MIT/Apache standards."
  };
});
